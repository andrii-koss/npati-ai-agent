import { expect, it, vi } from "vitest";
import type { AIEngine, OmniRouteMarketplace } from "@npati/omniroute-adapter";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import { buildApp } from "../apps/agent-api/src/app";
import { ProjectPreviewService } from "../apps/agent-api/src/project-preview-service";
import { InMemoryActiveSessionRegistry } from "../apps/agent-api/src/distributed-session-registry";
it("ends the real batch SSE response and releases its stream lease",async()=>{
  const ctx={workspaceId:"game-stream",userId:"owner",permissions:["workspace:read","workspace:write","business:manage","tools:execute"]};
  const store=new InMemoryWorkspaceStore(),registry=new InMemoryActiveSessionRegistry();
  const engine={chat:async()=>({content:JSON.stringify({intent:"PREVIEW_PROJECT",confidence:.99,targets:[],coreCapability:null})}),async*stream(){yield""},listModels:async()=>[],getModel:async()=>undefined,executeTool:async()=>undefined,searchMemory:async()=>[],saveMemory:async()=>undefined,getCapabilities:async()=>["chat"],healthCheck:async()=>({status:"ok"})} as AIEngine;
  const preview=vi.spyOn(ProjectPreviewService.prototype,"getPreviewStatus").mockResolvedValue({isRunning:true} as never);
  const app=buildApp({workspaceStore:store,authProvider:{authenticate:async()=>ctx},aiEngine:engine,marketplace:{marketplace:async()=>({overview:{connectedProviders:1}})} as unknown as OmniRouteMarketplace,activeSessionRegistry:registry,deploymentType:"self_hosted"});
  const company=await store.createCompany(ctx,{name:"Game stream"},"stream-company");for(const name of ["Snake Stream","TTT Stream"])await store.createProject(ctx,company.id,{name,type:"code_project"},name);
  await app.listen({host:"127.0.0.1",port:0});const base="http://127.0.0.1:"+(app.server.address() as {port:number}).port,controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),2500);
  try{const r=await fetch(base+"/chat/stream",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({streamId:crypto.randomUUID(),message:'Open Preview for Snake Stream and TTT Stream',contextType:"company",companyId:company.id}),signal:controller.signal});expect(r.status).toBe(200);const text=await r.text();expect(text).toContain('"routed":"code_project_batch"');expect(text).toContain('"status":"completed"');expect(preview).toHaveBeenCalledTimes(2);for(let i=0;i<20&&await registry.count(ctx.workspaceId,ctx.userId);i++)await new Promise(r=>setTimeout(r,10));expect(await registry.count(ctx.workspaceId,ctx.userId)).toBe(0);}finally{clearTimeout(timeout);controller.abort();preview.mockRestore();await app.close();}
},15000);
