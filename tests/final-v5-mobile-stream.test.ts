import {expect,it,vi} from 'vitest';
import {InMemoryWorkspaceStore} from '@npati/workspace';
import {buildApp} from '../apps/agent-api/src/app';
import {ProjectOrchestrator} from '../apps/agent-api/src/project-orchestrator';
it.each(['Expo','Flutter'])('routes a new %s Mobile App into existing Code preparation rather than the legacy Company runtime',async framework=>{
 const ctx={workspaceId:'mobile-stream-'+framework,userId:'owner',permissions:['workspace:read','workspace:write','business:manage','tools:execute']};
 const store=new InMemoryWorkspaceStore();const company=await store.createCompany(ctx,{name:'Mobile stream'},'mobile-stream');
 const engine={chat:async()=>({content:JSON.stringify({intent:'CREATE_WEBSITE',confidence:.99,targets:[{name:'Native Todo',kind:'mobile_app',framework,reason:'explicit',criteria:['user constraint']}]})}),async*stream(){yield ''},listModels:async()=>[],getModel:async()=>undefined,healthCheck:async()=>({status:'ok'})};
 const prepare=vi.spyOn(ProjectOrchestrator.prototype,'prepareCodingMobile').mockRejectedValue(Error('native-preparation-boundary'));
 const legacy=vi.spyOn(ProjectOrchestrator.prototype,'executeWebsiteTask').mockRejectedValue(Error('legacy-company-runtime'));
 const app=buildApp({workspaceStore:store,authProvider:{authenticate:async()=>ctx},aiEngine:engine,marketplace:{marketplace:async()=>({overview:{connectedProviders:1}})},deploymentType:'self_hosted'} as never);
 try{const response=await app.inject({method:'POST',url:'/chat/stream',payload:{streamId:crypto.randomUUID(),message:`Create ${framework} mobile app named Native Todo`,contextType:'company',companyId:company.id}});
 expect(response.statusCode,response.body).toBe(500);expect(prepare).toHaveBeenCalledOnce();expect(prepare.mock.calls[0]?.[1]).toMatchObject({type:'mobile_app',kind:'mobile_app',name:'Native Todo'});expect(prepare.mock.calls[0]?.[3]).toBe(framework);expect(legacy).not.toHaveBeenCalled();
 }finally{prepare.mockRestore();legacy.mockRestore();await app.close();}
},15000);
