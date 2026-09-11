import {afterEach,describe,expect,it} from "vitest";
import {buildApp} from "../apps/agent-api/src/app";
import {InMemoryWorkspaceStore,type AuthContext} from "@npati/workspace";

const apps:Array<ReturnType<typeof buildApp>>=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});

describe("Company Org Chart bounded pagination",()=>{
  it("pages beyond 100 agents and keeps every edge request bounded to the current page",async()=>{
    const store=new InMemoryWorkspaceStore();await store.initialize();
    const context:AuthContext={workspaceId:"dev-workspace",userId:"dev-user",permissions:["workspace:read","workspace:write","business:manage","chat:use"]};
    const company=await store.createCompany(context,{name:"Large Org"},"large-org-company");
    await Promise.all(Array.from({length:121},(_,index)=>store.createCompanyAgent(context,company.id,{name:`Agent ${index+1}`,role:"Worker"},`large-agent-${String(index).padStart(4,"0")}`)));
    const app=buildApp({workspaceStore:store});apps.push(app);

    const pages:Array<{agents:Array<{id:string}>;pagination:{nextCursor:string|null}}>=[];let cursor:string|undefined;
    do{
      const response=await app.inject({method:"GET",url:`/companies/${company.id}/agents?limit=60${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`});
      expect(response.statusCode).toBe(200);pages.push(response.json());cursor=response.json().pagination.nextCursor??undefined;
    }while(cursor);

    expect(pages.map(page=>page.agents.length)).toEqual([60,60,1]);
    expect(new Set(pages.flatMap(page=>page.agents.map(agent=>agent.id))).size).toBe(121);
    const parent=pages[0]!.agents[0]!,child=pages[1]!.agents[0]!;
    await store.setCompanyAgentParent(context,company.id,child.id,parent.id);
    for(const page of pages){
      const ids=page.agents.map(agent=>agent.id);
      expect(ids.length).toBeLessThanOrEqual(60);
      const edges=await app.inject({method:"GET",url:`/companies/${company.id}/agent-edges?agentIds=${encodeURIComponent(ids.join(","))}`});
      expect(edges.statusCode).toBe(200);
    }
    const crossPage=await app.inject({method:"GET",url:`/companies/${company.id}/agent-edges?agentIds=${child.id}`});
    expect(crossPage.json()).toEqual([expect.objectContaining({parentAgentId:parent.id,childAgentId:child.id})]);
    const tooMany=pages.flatMap(page=>page.agents).slice(0,101).map(agent=>agent.id).join(",");
    expect((await app.inject({method:"GET",url:`/companies/${company.id}/agent-edges?agentIds=${encodeURIComponent(tooMany)}`})).statusCode).toBe(400);
  });
});
