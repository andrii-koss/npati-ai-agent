import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CompanyToolRuntime } from "../apps/agent-api/src/company-tool-runtime";
import type { AIEngine } from "@npati/omniroute-adapter";
import type { AuthContext, Company } from "@npati/workspace";

const context: AuthContext={workspaceId:"ws-a",userId:"user-a",permissions:["business:manage"]};
const company: Company={id:"company-a",workspaceId:"ws-a",userId:"user-a",name:"Acme",languages:[],knowledge:[
  "inline knowledge",{id:"doc",name:"Guide",content:"company-only content"}],memory:{},status:"active",revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true})});

describe("Company tool runtime adapters",()=>{
  it("reuses the crawler provider with bounded crawl input",async()=>{
    const crawl=vi.fn(async(input)=>({pages:[],input}));
    const runtime=new CompanyToolRuntime({executeTool:vi.fn()} as unknown as AIEngine,{crawl} as never);
    const result=await runtime.execute(context,company,"web.crawl",{url:"https://example.com",maxPages:999,maxDepth:99},new AbortController().signal) as {input:{maxPages:number;maxDepth:number}};
    expect(crawl).toHaveBeenCalledOnce();
    expect(result.input).toMatchObject({maxPages:10,maxDepth:2});
  });
  it("allows only explicitly safe OmniRoute MCP tools",async()=>{
    const mcpCall=vi.fn(async()=>({ok:true}));
    const runtime=new CompanyToolRuntime({executeTool:vi.fn(),mcpCall} as unknown as AIEngine);
    await expect(runtime.execute(context,company,"mcp",{name:"omniroute_get_health"},new AbortController().signal)).resolves.toEqual({ok:true});
    await expect(runtime.execute(context,company,"mcp",{name:"omniroute_create_combo"},new AbortController().signal)).rejects.toThrow(/not permitted/);
    expect(mcpCall).toHaveBeenCalledTimes(1);
  });
  it("lists and reads only Company-linked inline files",async()=>{
    const runtime=new CompanyToolRuntime({executeTool:vi.fn()} as unknown as AIEngine);
    await expect(runtime.execute(context,company,"files",{operation:"list"},new AbortController().signal)).resolves.toHaveLength(2);
    await expect(runtime.execute(context,company,"files",{operation:"read",key:"doc"},new AbortController().signal)).resolves.toMatchObject({content:"company-only content"});
    await expect(runtime.execute(context,company,"files",{operation:"read",key:"missing"},new AbortController().signal)).rejects.toThrow(/not linked/);
  });
  it("blocks a linked attachment owned by another tenant",async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),"npati-files-"));dirs.push(dir);
    const id="11111111-1111-4111-8111-111111111111";
    await writeFile(path.join(dir,id+".json"),JSON.stringify({workspaceId:"ws-b",userId:"user-b",name:"secret"}));
    const runtime=new CompanyToolRuntime({executeTool:vi.fn()} as unknown as AIEngine,undefined,dir);
    await expect(runtime.execute(context,{...company,knowledge:[{attachmentId:id}]}, "files",{operation:"read",key:id},new AbortController().signal)).rejects.toThrow(/tenant access denied/);
  });
  it("rejects adapters that are not implemented",async()=>{
    const runtime=new CompanyToolRuntime({executeTool:vi.fn()} as unknown as AIEngine);
    await expect(runtime.execute(context,company,"shell",{},new AbortController().signal)).rejects.toThrow(/no runtime adapter/);
  });
  it("provides scoped Company Memory CRUD with separate read and write permission",async()=>{
    const memories=[{id:"memory-1",content:"Refunds take 14 days"}];
    const repository={
      memories:vi.fn(async()=>memories),getMemory:vi.fn(async()=>memories[0]),searchMemories:vi.fn(async()=>memories),
      addMemory:vi.fn(async(_ctx,_companyId,content)=>({id:"memory-2",content})),updateMemory:vi.fn(async(_ctx,_companyId,id,content)=>({id,content})),deleteMemory:vi.fn(async()=>true),
    };
    const runtime=new CompanyToolRuntime({executeTool:vi.fn()} as unknown as AIEngine,undefined,undefined,undefined,repository);
    await expect(runtime.execute(context,company,"storage.company_memory",{operation:"search",query:"Refunds"},new AbortController().signal)).resolves.toEqual(memories);
    await expect(runtime.execute(context,company,"storage.company_memory",{operation:"list"},new AbortController().signal)).resolves.toEqual(memories);
    await expect(runtime.execute(context,company,"storage.company_memory",{operation:"get",id:"memory-1"},new AbortController().signal)).resolves.toEqual(memories[0]);
    await expect(runtime.execute(context,company,"storage.company_memory",{operation:"create",content:"Escalate after 24 hours"},new AbortController().signal)).resolves.toMatchObject({id:"memory-2"});
    await expect(runtime.execute(context,company,"storage.company_memory",{operation:"update",id:"memory-1",content:"Refunds take 10 days"},new AbortController().signal)).resolves.toMatchObject({id:"memory-1",content:"Refunds take 10 days"});
    await expect(runtime.execute(context,company,"storage.company_memory",{operation:"delete",id:"memory-1"},new AbortController().signal)).resolves.toEqual({id:"memory-1",deleted:true});
    await expect(runtime.execute({...context,permissions:["workspace:read"]},company,"storage.company_memory",{operation:"create",content:"blocked"},new AbortController().signal)).rejects.toThrow(/write permission/);
    await expect(runtime.execute({...context,workspaceId:"ws-b"},company,"storage.company_memory",{operation:"list"},new AbortController().signal)).rejects.toThrow(/tenant access denied/);
    expect(repository.searchMemories).toHaveBeenCalledWith(context,company.id,"Refunds",20);
    expect(repository.updateMemory).toHaveBeenCalledWith(context,company.id,"memory-1","Refunds take 10 days");
    expect(repository.deleteMemory).toHaveBeenCalledWith(context,company.id,"memory-1");
  });
});

it("uses the same validated fetch provider for Company research and never bypasses it through OmniRoute", async () => {
  const executeTool = vi.fn(), fetch = vi.fn(async (_input: unknown) => ({ text: "validated page" }));
  const runtime = new CompanyToolRuntime({ executeTool } as unknown as AIEngine, { fetch } as never);
  await expect(runtime.execute(context, company, "web.fetch", { url: "https://example.com" }, new AbortController().signal))
    .resolves.toMatchObject({ text: "validated page" });
  expect(fetch).toHaveBeenCalledWith({ url: "https://example.com" });
  fetch.mockRejectedValueOnce(new Error("private_destination"));
  await expect(runtime.execute(context, company, "web.fetch", { url: "http://127.0.0.1" }, new AbortController().signal)).rejects.toThrow("private_destination");
  expect(executeTool).not.toHaveBeenCalled();
  const unavailable = new CompanyToolRuntime({ executeTool } as unknown as AIEngine);
  await expect(unavailable.execute(context, company, "web.fetch", { url: "https://example.com" }, new AbortController().signal)).rejects.toThrow("Validated web research provider");
  expect(executeTool).not.toHaveBeenCalled();
});
