import {readFileSync} from "node:fs";
import {afterEach,describe,expect,it,vi} from "vitest";
import {ProductionQdrantClient} from "../apps/agent-api/src/qdrant-client";

describe("advanced memory production contracts",()=>{
 afterEach(()=>vi.restoreAllMocks());
 it("Qdrant always applies workspace, company, and user filters",async()=>{
  const fetchMock=vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(new Response(JSON.stringify({result:{config:{params:{vectors:{size:3}},quantization_config:{scalar:{type:"int8"}}}}}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({result:[]}),{status:200}));
  await new ProductionQdrantClient("http://qdrant:6333").search({workspaceId:"w",companyId:"c",userId:"u"},[1,0,0],5);
  const body=JSON.parse(String(fetchMock.mock.calls[1]![1]?.body));
  expect(body.filter.must).toEqual(expect.arrayContaining([{key:"workspaceId",match:{value:"w"}},{key:"companyId",match:{value:"c"}},{key:"userId",match:{value:"u"}}]));
 });
 it("ships durable schema, revisions, idempotency, and lifecycle cleanup",()=>{
  const migration=readFileSync(new URL("../packages/workspace/src/migration-034.ts",import.meta.url),"utf8");
  expect(migration).toContain("company_memory_wiki_path_unique");
  expect(migration).toContain("company_dreaming_idempotency_unique");
  expect(migration).toContain("company_action_memory_idempotency_unique");
  const routes=readFileSync(new URL("../apps/agent-api/src/company-knowledge-routes.ts",import.meta.url),"utf8");
  expect(routes).toContain("deleteDocumentVectors");
  expect(routes).toContain("/knowledge/wiki/backlinks");
 });
 it("injects action-sensitive memory before delegation planning",()=>{
  const runtime=readFileSync(new URL("../apps/agent-api/src/company-runtime.ts",import.meta.url),"utf8");
  expect(runtime.indexOf("const actionPlanningContext")).toBeLessThan(runtime.indexOf("const planned = await this.ai.a2aSend"));
  expect(runtime).toContain("Mandatory action-sensitive rules");
  expect(runtime).toContain("plan.toolRequests.map(request=>request.tool)");
 });
});
