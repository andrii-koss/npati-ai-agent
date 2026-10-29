import {expect,it} from 'vitest';
import {InMemoryWorkspaceStore} from '@npati/workspace';
import {CodeService} from '../apps/agent-api/src/code-service';import {ProjectService} from '../apps/agent-api/src/project-service';
it('verifies a FastAPI project using its provisioned local venv instead of unrelated global Python',async()=>{
 const ctx={workspaceId:'backend-verify',userId:'owner',permissions:['workspace:read','workspace:write','business:manage']},store=new InMemoryWorkspaceStore();await store.initialize();const c=await store.createCompany(ctx,{name:'Backend'},'backend-verify');
 const files:Record<string,string>={'requirements.txt':'fastapi\n','pytest.ini':'[pytest]\ntestpaths=tests'},workspace={listFiles:async()=>Object.keys(files).map(path=>({path,type:'file'})),readFile:async(_a:unknown,_b:string,_c:string,p:string)=>({content:files[p]})};
 const projects=new ProjectService(store),service=new CodeService(store,projects,workspace as never,undefined,undefined,undefined,{assertEnabled:async()=>true} as never);let p=await service.createProject(ctx,c.id,{name:'FastAPI'});p=await projects.updatePreview(ctx,c.id,p.id,{framework:'FastAPI'});
 expect((await service.resolveVerifyCommands(ctx,c.id,p.id)).test).toBe('.venv/bin/python -m pytest');
});
