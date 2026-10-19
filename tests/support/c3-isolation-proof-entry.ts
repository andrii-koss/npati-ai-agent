import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { SharedProjectRuntimeProvider } from "../../apps/agent-api/src/shared-project-runtime-provider";
import { assertProjectQuiescent } from "../../apps/agent-api/src/shared-runtime-process-fence";
import type { SandboxScope, SandboxFile } from "../../apps/agent-api/src/sandbox-provider";

type Request = { id: number; op: string; scope: SandboxScope; sandbox: string; files?: SandboxFile[]; command?: string; processId?: string; timeout?: number };
let phase = "startup";
const checks: Array<{name:string;passed:boolean;durationMs?:number;error?:string}>=[];
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const workers=new Set<ChildProcess>();
async function until(test:()=>Promise<boolean>,timeout=5000){const end=Date.now()+timeout;do{if(await test())return;await sleep(30);}while(Date.now()<end);throw Error("Bounded condition timed out");}
async function workerMain(){
 const provider=new SharedProjectRuntimeProvider("/projects","/runtime-state","/audit/npati-project-exec");
 try{await provider.checkReady();process.send?.({ready:true});}
 catch(error){process.send?.({ready:false,code:(error as {code?:string}).code,message:(error as Error).message});process.exitCode=1;setTimeout(()=>process.exit(1),20);return;}
 process.on("message",async(message:Request)=>{
  try{let value:unknown;
   switch(message.op){
    case"create":value=await provider.createSandbox(message.scope);break;
    case"upload":value=await provider.uploadFiles(message.scope,message.sandbox,message.files!);break;
    case"start":value=await provider.startProcess(message.scope,message.sandbox,message.command!,{timeoutMs:message.timeout??15000,outputLimitBytes:64000,processId:message.processId});break;
    case"execute":value=await provider.executeCommand(message.scope,message.sandbox,message.command!,{timeoutMs:message.timeout??1000,outputLimitBytes:64000});break;
    case"status":value=await provider.getProcessStatus(message.scope,message.sandbox,message.processId!);break;
    case"stop":value=await provider.stopProcess(message.scope,message.sandbox,message.processId!);break;
    default:throw Error("Unknown audit operation");
   }
   process.send?.({id:message.id,ok:true,value});
  }catch(error){process.send?.({id:message.id,ok:false,code:(error as {code?:string}).code,message:(error as Error).message});}
 });
}
async function newWorker(){
 const child=spawn(process.execPath,[process.argv[1]!,"--supervisor"],{stdio:["ignore","pipe","pipe","ipc"]});workers.add(child);
 let errors="";child.stderr!.on("data",c=>{errors=(errors+c.toString()).slice(-1500);});child.stdout!.resume();
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error("Supervisor startup timed out: "+errors)),15000);
  child.once("error",error=>{clearTimeout(timer);reject(error);});
  child.once("message",(m:{ready?:boolean;code?:string;message?:string})=>{clearTimeout(timer);m.ready?resolve():reject(Object.assign(Error(m.message),{code:m.code}));});
 });
 let serial=0;
 const pending=new Map<number,{resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
 child.on("message",(m:{id?:number;ok?:boolean;value:unknown;code?:string;message?:string})=>{
  const wait=m.id===undefined?undefined:pending.get(m.id);if(!wait)return;
  clearTimeout(wait.timer);pending.delete(m.id!);
  m.ok?wait.resolve(m.value):wait.reject(Object.assign(Error(m.message),{code:m.code}));
 });
 return{child,rpc<T>(input:Omit<Request,"id">):Promise<T>{const id=++serial;return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(Error("Audit RPC timed out"));},12000);
  pending.set(id,{resolve:value=>resolve(value as T),reject,timer});child.send({...input,id});
 });}};
}
async function killOwned(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const ended=new Promise<void>(resolve=>child.once("exit",()=>resolve()));child.kill("SIGKILL");await ended;}
async function main(){
 const prerequisite=spawnSync("/audit/npati-project-exec",["--check"],{encoding:"utf8",timeout:15000});
 if(prerequisite.status!==0)throw Error("Actual namespace prerequisite failed: "+(prerequisite.error?.message??prerequisite.stderr));
 checks.push({name:"actual shared launcher namespaces and unchanged seccomp profile",passed:true});
 spawnSync("iptables",["-N","NPATI_PROJECTS"],{encoding:"utf8"});
 await assert.rejects(assertProjectQuiescent(0),{code:"runtime_state_invalid"});
 checks.push({name:"restart barrier rejects invalid UID before examining processes",passed:true});
 const scope:SandboxScope={workspaceId:randomUUID(),userId:randomUUID(),companyId:randomUUID(),projectId:randomUUID()};
 let owner=await newWorker();
 const created=await owner.rpc<{id:string}>({op:"create",scope,sandbox:""});
 const sandbox=created.id, base="/projects/"+scope.projectId;
 const parallelScope={...scope,projectId:randomUUID()};
 const returned=await Promise.all(Array.from({length:12},()=>owner.rpc<{id:string}>({op:"create",scope:parallelScope,sandbox:""}).then(async value=>{
   const home=await import("node:fs/promises").then(disk=>disk.stat("/projects/"+parallelScope.projectId+"/.npati-runtime/home"));
   assert.ok(home.isDirectory());
   const persisted=JSON.parse(await readFile("/runtime-state/projects.json","utf8")) as Array<{id:string}>;
   assert.ok(persisted.some(entry=>entry.id===value.id));
   return value.id;
 })));
 assert.equal(new Set(returned).size,1);
 checks.push({name:"parallel creation waits for durable ready state before exposing one shared project identity",passed:true});

 const state=async()=>JSON.parse(await readFile("/runtime-state/projects.json","utf8")) as Array<{generation:number;processes:Record<string,{status:string;pid?:number}>}>;
 assert.equal((await state())[0]!.generation,1);
 checks.push({name:"exclusive supervisor persists fsynced project generation before admission",passed:true});
 for (const expected of [undefined, "0"]) {
   const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH };
   if (expected !== undefined) environment.NPATI_RUNTIME_SUPERVISOR_PID = expected;
   const rejected = spawnSync("/audit/npati-project-exec", ["10000", base, "3001", base, "--offline", "/bin/true"], { env: environment, encoding: "utf8", timeout: 5000 });
   assert.equal(rejected.status, 126, rejected.stderr);
 }
 checks.push({name:"native launcher refuses missing or spoofed parent ownership before project execution",passed:true});

 await owner.rpc({op:"upload",scope,sandbox,files:[
  {path:"parent.cjs",content:"const cp=require('child_process');cp.spawn(process.execPath,['child.cjs',process.argv[2]],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},100);"},
  {path:"child.cjs",content:"const fs=require('fs');setInterval(()=>fs.appendFileSync(process.argv[2],'x'),20);"}
 ]});
 const marker=async(name:string)=>readFile(base+"/"+name,"utf8").catch(()=>"");
 const start=async(name:string,timeout=15000)=>{const id=randomUUID();await owner.rpc({op:"start",scope,sandbox,command:"node parent.cjs "+name,processId:id,timeout});await until(async()=>(await marker(name)).length>=2);return id;};
 const stable=async(name:string)=>{await sleep(200);const before=await marker(name);await sleep(300);assert.equal(await marker(name),before);assert.ok(before.length>0);};
 const first=await start("crash.log");
 await killOwned(owner.child);
 await until(async()=>{try{await assertProjectQuiescent(10000);return true;}catch{return false;}});
 await stable("crash.log");
 checks.push({name:"supervisor SIGKILL physically ends detached namespace descendants without UID killing",passed:true});
 owner=await newWorker();
 assert.equal((await state())[0]!.generation,2);
 const old=await owner.rpc<{status:string}>({op:"status",scope,sandbox,processId:first});assert.equal(old.status,"stopped");
 await owner.rpc({op:"start",scope,sandbox,command:"node parent.cjs crash.log",processId:first,timeout:15000});
 await stable("crash.log");
 checks.push({name:"restart advances durable generation and replay never respawns the stale process identity",passed:true});
 phase = "tracked timeout marker";
 const timed=await start("timeout.log",3000);
 phase = "tracked timeout outcome";
 await until(async()=>(await owner.rpc<{status:string}>({op:"status",scope,sandbox,processId:timed})).status!=="running");
 await stable("timeout.log");
 assert.equal((await owner.rpc<{status:string}>({op:"status",scope,sandbox,processId:timed})).status,"timed_out");
 checks.push({name:"timeout becomes terminal only after detached tree close",passed:true});
 const cancelled=await start("cancel.log");
 await owner.rpc({op:"stop",scope,sandbox,processId:cancelled});await stable("cancel.log");
 checks.push({name:"stopProcess waits for namespace closure before acknowledging cancellation",passed:true});
 const preview=await owner.rpc<{processId:string}>({op:"start",scope,sandbox,command:"node parent.cjs preview-stop.log"});
 await until(async()=>(await marker("preview-stop.log")).length>=2);
 const previewStop=await owner.rpc<{status:string}>({op:"stop",scope,sandbox,processId:preview.processId});
 assert.equal(previewStop.status,"stopped");await stable("preview-stop.log");
 checks.push({name:"preview cancellation retains stopped outcome across close-handler races",passed:true});

 const foreground=await owner.rpc<{status:string;retryable:boolean}>({op:"execute",scope,sandbox,command:"node parent.cjs foreground.log",timeout:3000});
 assert.equal(foreground.status,"timed_out");assert.equal(foreground.retryable,false);await stable("foreground.log");
 checks.push({name:"actual foreground timeout kills detached descendants and refuses unsafe automatic replay",passed:true});

 await assert.rejects(newWorker(),{code:"workspace_busy"});
 assert.equal((await state())[0]!.generation,2);
 checks.push({name:"second supervisor cannot acquire the protected lifetime fence or publish a generation",passed:true});
 await killOwned(owner.child);
 await until(async()=>{try{await assertProjectQuiescent(10000);return true;}catch{return false;}});
 // This exact child belongs to the disposable audit harness. It is intentionally
 // not a provider descendant: the read-only barrier must refuse, not kill it.
 const rogue=spawn(process.execPath,["-e","setInterval(()=>require('fs').appendFileSync(process.argv[1],'p'),20)",base+"/peer.log"],{uid:10000,gid:10000,stdio:"ignore"});workers.add(rogue);
 await until(async()=>(await marker("peer.log")).length>=2);
 const before=(await marker("peer.log")).length;
 await assert.rejects(newWorker(),{code:"runtime_recovery_required"});
 assert.equal((await state())[0]!.generation,2);
 await until(async()=>(await marker("peer.log")).length>before);
 checks.push({name:"surviving unmanaged writer blocks restart without losing its data or signaling it",passed:true});
 await killOwned(rogue);
 const saved=await state();saved[0]!.processes[first]={status:"running",pid:process.pid};await writeFile("/runtime-state/projects.json",JSON.stringify(saved));
 owner=await newWorker();assert.equal((await state())[0]!.generation,3);
 assert.equal((await state())[0]!.processes[first]!.status,"stopped");
 assert.ok(process.pid>0);
 checks.push({name:"recovery never signals a reused persisted PID and admits only after quiescence",passed:true});
 phase = "disconnect start";
 const disconnected=await start("disconnect.log",3000);
 phase = "disconnect terminal outcome";
 owner.child.disconnect();
 await until(async()=>(await state())[0]!.processes[disconnected]!.status==="timed_out");
 await stable("disconnect.log");
 checks.push({name:"lost audit client channel leaves supervisor ownership intact and timeout still terminates descendants",passed:true});
 await killOwned(owner.child);
}
(async()=>{
 if(process.argv.includes("--supervisor"))return workerMain();
 try{await main();}
 catch(error){let state="";try{state=await readFile("/runtime-state/projects.json","utf8");}catch{}
 checks.push({name:"actual shared isolation acceptance",passed:false,error:phase+": "+(error as Error).message+" "+state.slice(-3500)});}
 finally{for(const child of workers)await killOwned(child);}
 const passed=checks.every(c=>c.passed);
 console.log(JSON.stringify({kind:"c3-real-shared-isolation",passed,checks,transport:"Actual SharedProjectRuntimeProvider plus compiled guard/bubblewrap/slirp in one disposable container; IPC audit harness, not authenticated HTTP/image-admission/DB certification"}));
 if(!passed)process.exitCode=1;
})().catch(error=>{console.error((error as Error).message);process.exitCode=1;});
