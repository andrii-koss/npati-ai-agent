import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { InMemoryWorkspaceStore } from "@npati/workspace";
import { registerApiKeyRoutes } from "../apps/agent-api/src/api-keys-routes";
import { ApiKeysRepository } from "../apps/agent-api/src/api-keys-repository";
import { AuthenticationError } from "../apps/agent-api/src/auth";

describe("Company API key route authorization", () => {
  it("rejects missing auth and forged tenant headers; binds all key actions to the authenticated company owner", async () => {
    const store = new InMemoryWorkspaceStore();
    const a = { workspaceId:"audit-ws-a", userId:"audit-user-a", permissions:["workspace:read","workspace:write"] };
    const b = { workspaceId:"audit-ws-b", userId:"audit-user-b", permissions:["workspace:read","workspace:write"] };
    const company = await store.createCompany(a,{name:"API key audit company"});
    const app=Fastify();
    app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof AuthenticationError?error.status:500).send({error:{message:error.message}}));
    registerApiKeyRoutes(app,new ApiKeysRepository(),{
      authenticate:async request=>{
        if(request.headers.authorization==="Bearer a")return a;
        if(request.headers.authorization==="Bearer b")return b;
        throw new AuthenticationError("Authentication required");
      }
    },store);
    const url="/companies/"+company.id+"/api-keys";
    try {
      for(const method of ["GET","POST","DELETE"] as const){
        const res=await app.inject({method,url:method==="DELETE"?url+"/unknown":url,headers:{"x-tenant-id":a.workspaceId},...(method==="POST"?{payload:{name:"untrusted"}}:{})});
        expect(res.statusCode).toBe(401);
      }
      const created=await app.inject({method:"POST",url,headers:{authorization:"Bearer a","x-tenant-id":b.workspaceId},payload:{name:"test",scopes:["read"]}});
      expect(created.statusCode).toBe(201);
      expect(created.json().key.tenantId).toBe(a.workspaceId);
      const keyId=created.json().key.id;
      for(const method of ["GET","POST","DELETE"] as const){
        const res=await app.inject({method,url:method==="DELETE"?url+"/"+keyId:url,headers:{authorization:"Bearer b","x-tenant-id":a.workspaceId},...(method==="POST"?{payload:{name:"untrusted"}}:{})});
        expect(res.statusCode).toBe(404);
      }
      const listed=await app.inject({method:"GET",url,headers:{authorization:"Bearer a"}});
      expect(listed.json().keys).toHaveLength(1);
      expect(listed.json().keys[0].rawToken).toBeUndefined();
      expect((await app.inject({method:"DELETE",url:url+"/"+keyId,headers:{authorization:"Bearer a"}})).statusCode).toBe(200);
    } finally {await app.close();}
  });
});
