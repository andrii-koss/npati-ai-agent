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
});
