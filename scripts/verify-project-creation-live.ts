import { randomUUID, createHmac } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { PostgresWorkspaceStore, type AuthContext } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";
import { DataBackendRepository } from "../apps/agent-api/src/data-studio/repository";
import { SharedPostgresProvisioner } from "../apps/agent-api/src/data-studio/provisioner";
import { CODE_AGENT_MASTER_FLAG } from "../apps/agent-api/src/feature-flags";

const sourceUrl=process.env.DATABASE_URL!;
assert(sourceUrl,"Run inside the local API container");
const admin=new Pool({connectionString:sourceUrl});
const db="npati_creation_"+randomUUID().replaceAll("-","");
const testUrl=new URL(sourceUrl);testUrl.pathname="/"+db;
const directory=await mkdtemp(path.join(tmpdir(),"npati-creation-"));
const ctx:AuthContext={workspaceId:"creation-audit",userId:"creation-audit",permissions:["admin:all","workspace:read","workspace:write","business:manage","tools:execute"]};
const originalUrl=new URL(sourceUrl);
delete process.env.FTS5_DB_PATH;
process.env.NPATI_DATA_BACKUP_DISABLED="true";
process.env.NPATI_PROJECTS_SNAPSHOT_DIR=path.join(directory,"snapshots");
process.env.NPATI_PROJECTS_POSTGRES_HOST=originalUrl.hostname;
process.env.NPATI_PROJECTS_POSTGRES_PORT=originalUrl.port||"5432";
process.env.NPATI_PROJECTS_POSTGRES_ADMIN_USER=decodeURIComponent(originalUrl.username);
process.env.NPATI_PROJECTS_POSTGRES_ADMIN_PASSWORD=decodeURIComponent(originalUrl.password);
let app:ReturnType<typeof buildApp>|undefined;
let store:PostgresWorkspaceStore|undefined,repository:DataBackendRepository|undefined,provisioner:SharedPostgresProvisioner|undefined;
let companyId="",projectId="",sandboxId="",processId="",backendId="";
const evidence:Record<string,unknown>={prompt:"\u0421\u0442\u0432\u043e\u0440\u0438\u0442\u0438 \u0441\u0443\u0447\u0430\u0441\u043d\u0438\u0439 \u0456\u043d\u0442\u0435\u0440\u043d\u0435\u0442-\u043c\u0430\u0433\u0430\u0437\u0438\u043d \u043d\u0430 HTML / CSS / JavaScript",startedAt:new Date().toISOString()};
async function runner(operation:string,payload:unknown){
 const body=JSON.stringify({operation,payload}),timestamp=String(Date.now()),nonce=randomUUID();
 const signature=createHmac("sha256",process.env.NPATI_SANDBOX_RUNNER_SECRET!).update(timestamp+"."+nonce+"."+body).digest("hex");
 const response=await fetch(process.env.NPATI_SANDBOX_RUNNER_URL!+"/v1/sandbox",{method:"POST",headers:{"content-type":"application/json","x-npati-timestamp":timestamp,"x-npati-nonce":nonce,"x-npati-signature":signature},body});
 if(!response.ok)throw Error("runner "+response.status);return response.json();
}
try {
 await admin.query('CREATE DATABASE "'+db+'"');
 store=new PostgresWorkspaceStore(testUrl.toString());await store.initialize(ctx);
 const company=await store.createCompany(ctx,{name:"Disposable creation audit"},"creation-audit");companyId=company.id;
 const preferences=await admin.query("SELECT DISTINCT ON(setting_key) setting_key,value FROM workspace_user_settings WHERE setting_key=ANY($1::text[]) ORDER BY setting_key,updated_at DESC",[["ai.preferences","code.preferences"]]);
 for(const row of preferences.rows)await store.setUserSetting(ctx,row.setting_key,row.value,0);
 for(const flagKey of [CODE_AGENT_MASTER_FLAG,"code.read","code.write","code.shell","code.git","code.background_runs"])await store.setFeatureFlag(ctx,{scope:"company",scopeId:company.id,flagKey,stage:"internal",enabled:true});
 let scriptedTurn = 0;
 const scriptedEngine = process.env.NPATI_CREATION_SCRIPTED ? { chat: async () => (++scriptedTurn === 1 ? { content: "Creating the requested site.", toolCalls: [{ id: randomUUID(), type: "function" as const, function: { name: "code.fs.write", arguments: JSON.stringify({path:"index.html", content:"<!doctype html><html><head><title>Audit</title></head><body><main><h1>Audit store</h1></main></body></html>"}) } }] } : {content:"The site is ready."}) } : undefined;
 app=buildApp({...(scriptedEngine ? {aiEngine:scriptedEngine} : {}),databaseUrl:testUrl.toString(),workspaceStore:store,dataDirectory:directory,projectWorkspaceRoot:path.join(directory,"projects"),authProvider:{authenticate:async()=>ctx},omnirouteBaseUrl:process.env.OMNIROUTE_BASE_URL,omnirouteApiKey:process.env.OMNIROUTE_API_KEY,omnirouteManagementPassword:process.env.OMNIROUTE_MANAGEMENT_PASSWORD,deploymentType:"self_hosted"});
 await app.ready();
 const acceptedAt=Date.now();
 const started=await app.inject({method:"POST",url:"/chat/development/processes",payload:{companyId:company.id,requestId:randomUUID(),message:evidence.prompt}});
 assert.equal(started.statusCode,200,started.body);
 processId=started.json().processes[0].id;
 evidence.acceptedStatus=started.json().processes[0].status;
 assert.equal(evidence.acceptedStatus,"running");
 let development:any;
 const deadline=Date.now()+600000;
 while(Date.now()<deadline){
  const response=await app.inject({method:"GET",url:"/chat/development/processes"});assert.equal(response.statusCode,200);
  development=response.json().processes.find((p:any)=>p.id===processId);
  if(development?.projectId)projectId=development.projectId;
  if(process.env.NPATI_FIRST_WRITE_PROBE && development?.progress?.some((item:any)=>item.tool==="code.fs.write" && item.status==="completed"))break;
  if(development&&!["queued","preparing","running","stopping"].includes(development.status))break;
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 evidence.elapsedMs=Date.now()-acceptedAt;evidence.status=development?.status;
 evidence.setupStages=development?.progress?.filter((item:any)=>["project","scaffold","dependencies"].includes(item.stage)).map((item:any)=>item.stage)??[];
 assert.deepEqual(evidence.setupStages,[]);
 if(process.env.NPATI_FIRST_WRITE_PROBE){
  const diagnostic=new Pool({connectionString:testUrl.toString()});
  const calls=await diagnostic.query("SELECT tool_calls FROM code_run_turns WHERE run_id=$1 ORDER BY turn_index",[development.runId]);
  evidence.tools=calls.rows.flatMap(r=>r.tool_calls.map((t:any)=>t.tool));
  evidence.firstTokens=(await diagnostic.query("SELECT payload FROM code_activity_events WHERE run_id=$1 AND payload->>\'eventType\'=\'model_first_token\' ORDER BY created_at",[development.runId])).rows.map(r=>({turn:r.payload.turn,firstTokenMs:r.payload.firstTokenMs}));
  await diagnostic.end();
  assert.equal((evidence.tools as string[])[0],"code.fs.write");
  evidence.status="first_write_verified";
  console.info("CREATION_AUDIT_RESULT "+JSON.stringify(evidence));
 }else{
 assert.equal(development?.status,"completed",JSON.stringify({status:development?.status,detail:development?.detail}));
 const project=await store.getProject(ctx,company.id,development.projectId);projectId=project.id;sandboxId=project.sandboxId!;
 assert.equal(project.dataBackendId,null);
 const pool=new Pool({connectionString:testUrl.toString()});
 assert.equal((await pool.query("SELECT count(*)::integer AS n FROM data_backends")).rows[0].n,0);
 const calls=await pool.query("SELECT tool_calls FROM code_run_turns WHERE run_id=$1 ORDER BY turn_index",[development.runId]);
 evidence.tools=calls.rows.flatMap(r=>r.tool_calls.map((t:any)=>t.tool));
 evidence.firstTokens=(await pool.query("SELECT payload FROM code_activity_events WHERE run_id=$1 AND payload->>\'eventType\'=\'model_first_token\' ORDER BY created_at",[development.runId])).rows.map(r=>({turn:r.payload.turn,firstTokenMs:r.payload.firstTokenMs}));
 evidence.databaseCountAfterHtml=0;
 const preview=await app.inject({method:"GET",url:project.previewUrl!.replace(/^\/api/,"")});
 assert.equal(preview.statusCode,200,preview.body.slice(0,200));
 evidence.previewStatus=preview.statusCode;
 // Real provisioning through the tool API; no LLM is asked to create extra features.
 const root="/companies/"+company.id+"/projects/"+project.id+"/code/tools/invoke";
 const invoke=async(tool:string,args:unknown)=>{const r=await app!.inject({method:"POST",url:root,payload:{tool,args,sessionId:development.sessionId,toolCallId:randomUUID()}});const data=r.json();assert.equal(data.ok,true,JSON.stringify(data));return data;};
 const first=await invoke("code.data.backend.create",{name:"Creation audit orders",reason:"Explicit diagnostic request to persist orders"});
 const attached=await store.getProject(ctx,company.id,project.id);backendId=attached.dataBackendId!;
 assert(backendId);
 const second=await invoke("code.data.backend.create",{name:"Creation audit orders",reason:"Repeat the explicit request to verify idempotency"});
 assert.equal((await pool.query("SELECT count(*)::integer AS n FROM data_backends")).rows[0].n,1);
 assert.equal((await store.getProject(ctx,company.id,project.id)).dataBackendId,backendId);
 const conversation=await store.getNeutralConversation(ctx,development.conversationId);
 assert(conversation.messages.some(m=>m.role==="assistant"&&m.content.includes("Creation audit orders")));
 evidence.onDemandDatabase={created:true,retryReusedSameBackend:true,noticeInChat:true};
 evidence.toolResponseContainsCredentials=/postgres(?:ql)?:\/\/|DATABASE_URL|ADMIN_PASSWORD|PROJECT_SECRET_KEY/.test(JSON.stringify([first,second]));
 assert.equal(evidence.toolResponseContainsCredentials,false);
 await pool.end();
 console.info("CREATION_AUDIT_RESULT "+JSON.stringify(evidence));
 }
} catch(error) { evidence.error=error instanceof Error?error.message:String(error);console.error("CREATION_AUDIT_ERROR "+JSON.stringify(evidence));process.exitCode=1; }
finally{
 await writeFile("/tmp/project-creation-audit-"+db+".json",JSON.stringify(evidence,null,2));
 if(app&&processId)await app.inject({method:"POST",url:"/chat/development/processes/"+processId+"/stop"}).catch(()=>undefined);
 if(store&&companyId&&projectId){const project=await store.getProject(ctx,companyId,projectId).catch(()=>null);sandboxId=project?.sandboxId||sandboxId;backendId=project?.dataBackendId||backendId;}
 if(sandboxId)await runner("destroySandbox",{scope:{workspaceId:ctx.workspaceId,userId:ctx.userId,companyId,projectId},sandboxId}).catch(e=>console.error("diagnostic runtime cleanup: "+e.message));
 if(store&&backendId){
  repository=new DataBackendRepository(testUrl.toString());
  provisioner=new SharedPostgresProvisioner({host:originalUrl.hostname,port:Number(originalUrl.port||5432),adminUser:decodeURIComponent(originalUrl.username),adminPassword:decodeURIComponent(originalUrl.password),maintenanceDatabase:originalUrl.pathname.slice(1),snapshotDirectory:path.join(directory,"snapshots")},repository);
  const backend=await repository.get(ctx,companyId,backendId);
  for(const env of ["dev","prod"] as const)await provisioner.deprovisionDatabase(backend,env).catch(e=>console.error("diagnostic database cleanup: "+e.message));
 }
 await app?.close().catch(()=>undefined);
 await repository?.pool.end();
 await (provisioner as any)?.adminPool.end();
 await store?.close().catch(()=>undefined);
 await admin.query('DROP DATABASE IF EXISTS "'+db+'" WITH (FORCE)');
 await admin.end();
 await writeFile("/tmp/project-creation-audit-result.json",JSON.stringify(evidence,null,2));
 await rm(directory,{recursive:true,force:true});
}
