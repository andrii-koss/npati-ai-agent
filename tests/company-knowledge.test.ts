import { readFileSync } from "node:fs";
import { describe,expect,it,vi } from "vitest";
import { CompanyKnowledgeProcessor,type KnowledgeDocument } from "../apps/agent-api/src/company-knowledge";
import { InMemoryObjectStorage,NPATI_BUCKETS } from "../apps/agent-api/src/object-storage";
import { InMemoryFileMetadataRepository } from "../apps/agent-api/src/file-metadata";
const ctx={workspaceId:"10000000-0000-0000-0000-000000000001",userId:"20000000-0000-0000-0000-000000000001",permissions:["workspace:read"]};
describe("Company Knowledge processing",()=>{
 it("extracts, chunks, embeds and stores a tenant-scoped text document",async()=>{
  const companyId="30000000-0000-0000-0000-000000000001",fileId="40000000-0000-0000-0000-000000000001",storage=new InMemoryObjectStorage(),files=new InMemoryFileMetadataRepository();
  const data=Buffer.from("NPATI brand rule: answer clearly. ".repeat(100)),key="workspace/"+ctx.workspaceId+"/companies/"+companyId+"/knowledge/"+fileId;await storage.put(NPATI_BUCKETS.knowledge,key,data);
  await files.reserve(ctx,{id:fileId,workspaceId:ctx.workspaceId,userId:ctx.userId,companyId,bucket:NPATI_BUCKETS.knowledge,objectKey:key,originalFilename:"rules.txt",mimeType:"text/plain",sizeBytes:data.length,checksum:"x",category:"document"});await files.markReady(ctx,fileId);
  const doc={id:"50000000-0000-0000-0000-000000000001",workspaceId:ctx.workspaceId,companyId,userId:ctx.userId,fileId,status:"uploaded",chunkCount:0,attemptCount:0,createdAt:"",updatedAt:""} as KnowledgeDocument;
  const complete=vi.fn(),repo={claim:vi.fn().mockResolvedValue(doc),complete,fail:vi.fn(),candidates:vi.fn()};
  const ai={embed:vi.fn(async({input}:{input:string[]})=>({model:"test/embed",vectors:input.map(()=>[1,0,0])}))};
  await new CompanyKnowledgeProcessor(repo as any,files,storage,ai as any).process(doc.id);
  expect(complete).toHaveBeenCalledOnce();expect(complete.mock.calls[0]![1].length).toBeGreaterThan(1);expect(complete.mock.calls[0]![2]).toBe("test/embed");
 });
 it("extracts all sheets from an Excel workbook",async()=>{
  const companyId="30000000-0000-0000-0000-000000000001",fileId="40000000-0000-0000-0000-000000000002",storage=new InMemoryObjectStorage(),files=new InMemoryFileMetadataRepository();
  const data=readFileSync(new URL("./fixtures/company-knowledge.xlsx",import.meta.url)),key="workspace/"+ctx.workspaceId+"/companies/"+companyId+"/knowledge/"+fileId;await storage.put(NPATI_BUCKETS.knowledge,key,data);
  await files.reserve(ctx,{id:fileId,workspaceId:ctx.workspaceId,userId:ctx.userId,companyId,bucket:NPATI_BUCKETS.knowledge,objectKey:key,originalFilename:"company-knowledge.xlsx",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",sizeBytes:data.length,checksum:"xlsx",category:"document"});await files.markReady(ctx,fileId);
  const doc={id:"50000000-0000-0000-0000-000000000002",workspaceId:ctx.workspaceId,companyId,userId:ctx.userId,fileId,status:"uploaded",chunkCount:0,attemptCount:0,createdAt:"",updatedAt:""} as KnowledgeDocument;
  const complete=vi.fn(),repo={claim:vi.fn().mockResolvedValue(doc),complete,fail:vi.fn()};const ai={embed:vi.fn(async({input}:{input:string[]})=>({model:"test/embed",vectors:input.map(()=>[1,0,0])}))};
  await new CompanyKnowledgeProcessor(repo as any,files,storage,ai as any).process(doc.id);
  const content=complete.mock.calls[0]![1].map((item:{content:string})=>item.content).join("\n");expect(content).toContain("[Sheet: Knowledge]");expect(content).toContain("NPATI Pro");expect(content).toContain("09:00-18:00 Kyiv");
 });
 it("uses OmniRoute rerank order after vector candidates",async()=>{
  const repo={candidates:vi.fn().mockResolvedValue([{content:"A",score:.5},{content:"B",score:.4}])};
  const ai={embed:vi.fn().mockResolvedValue({model:"embed",vectors:[[1,0]]}),rerank:vi.fn().mockResolvedValue({model:"rerank",results:[{index:1,relevanceScore:.9}]})};
  const result=await new CompanyKnowledgeProcessor(repo as any,{} as any,{} as any,ai as any).retrieve(ctx,"company","query",1);
  expect(result).toEqual([{content:"B",score:.4}]);
 });
});
