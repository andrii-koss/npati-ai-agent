import { createHmac,randomUUID } from "node:crypto";
import { createFrameworkScaffold } from "../apps/agent-api/src/project-framework-scaffold";
import { minimalNextScaffold } from "../apps/agent-api/src/project-minimal-scaffold";
import { detectProjectStack } from "../apps/agent-api/src/project-preview-stack";
import assert from "node:assert/strict";
async function request(operation:string,payload:any){
 const body=JSON.stringify({operation,payload}),timestamp=String(Date.now()),nonce=randomUUID();
 const signature=createHmac("sha256",process.env.NPATI_SANDBOX_RUNNER_SECRET!).update(timestamp+"."+nonce+"."+body).digest("hex");
 const response=await fetch(process.env.NPATI_SANDBOX_RUNNER_URL!+"/v1/sandbox",{method:"POST",headers:{"content-type":"application/json","x-npati-timestamp":timestamp,"x-npati-nonce":nonce,"x-npati-signature":signature},body,signal:AbortSignal.timeout(650000)});
 const data=await response.json();if(!response.ok)throw Error(data.error?.message||String(response.status));return data.result;
}
for(const framework of ["Next.js","React + Vite","Vue 3 + Vite"]){
 const started=Date.now();
 const scope={workspaceId:"minimal-framework-audit",userId:"diagnostic",companyId:randomUUID(),projectId:randomUUID()};
 const created=await request("createSandbox",{scope}),project={scope,sandboxId:created.id};
 try{
  await request("startSandbox",project);
  const files=framework==="Next.js"?minimalNextScaffold("framework-test"):createFrameworkScaffold({projectName:"framework-test",framework,prompt:""});
  await request("uploadFiles",{...project,files:Object.entries(files).map(([path,content])=>({path,content}))});
  const options={timeoutMs:600000,outputLimitBytes:2000};
  for(const command of ["npm ci","npm run build"]){const result=await request("executeCommand",{...project,command,options});assert.equal(result.exitCode,0,framework+" "+command+": "+result.stderr+" "+result.stdout);}
  const stack=await detectProjectStack(Object.keys(files).map(path=>({path})),async p=>files[p]!);
  const exposed=await request("exposePort",{...project,port:stack.port});
  await request("startProcess",{...project,command:stack.productionCommand||stack.command,options});
  let response:any;
  for(let i=0;i<30;i++){response=await request("proxyPreview",{...project,options:{port:exposed.port,path:"/",method:"GET",headers:{}}}).catch(()=>null);if(response?.status===200)break;await new Promise(r=>setTimeout(r,1000));}
  assert.equal(response?.status,200,framework+" Preview");
  const html=Buffer.from(response.body,"base64").toString();
  assert(!/Interactive demo|Click me|responsive starter|hosting plans/i.test(html));
  console.info(JSON.stringify({framework,install:"npm ci passed",build:"passed",preview:response.status,elapsedMs:Date.now()-started}));
 }finally{await request("destroySandbox",project);}
}
