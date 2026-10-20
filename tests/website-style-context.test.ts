import { expect, it } from "vitest";
import { buildWebsiteStyleContext } from "../apps/agent-api/src/website-style-context";
it("supplies real stylesheet paths and CSS import order without copying whole source files", async()=>{
 const reads:string[]=[];
 const result=await buildWebsiteStyleContext([{path:"app/globals.css"},{path:"app/store.css"},{path:"app/layout.tsx"}],async path=>{reads.push(path);return 'import "./globals.css";\nimport "./store.css";\nexport default function Layout(){ return "unrelated implementation"; }';});
 expect(result).toContain("app/store.css");expect(JSON.parse(result!.slice(result!.indexOf("\n")+1)).entries[0].imports).toEqual(['import "./globals.css"','import "./store.css"']);expect(result).not.toContain("unrelated implementation");expect(reads).toEqual(["app/layout.tsx"]);
});
it("omits hints when no stylesheet exists and tolerates an unreadable entry",async()=>{
 expect(await buildWebsiteStyleContext([],async()=>{throw Error("must not read")})).toBeNull();
 expect(await buildWebsiteStyleContext([{path:"styles.css"},{path:"App.tsx"}],async()=>{throw Error("unreadable")})).toContain("styles.css");
});

it("uses existing persisted edit summaries only for the selected project and checks file revisions", async()=>{
 const {rememberWebsiteEdit,websiteEditMemory}=await import("../apps/agent-api/src/website-style-context");
 const saved:any[]=[];const store={createCodeContextSummary:async(input:any)=>{saved.push(input);return input;}};
 const files=[{path:"app/global.css",name:"global.css",type:"file" as const,revision:"r1"}];
 await rememberWebsiteEdit(store as never,{listFiles:async()=>files} as never,{} as never,{companyId:"c",projectId:"p",id:"s"},
  {status:"completed",runId:"run",message:"White background applied",summary:{filesChanged:["app/global.css"]},websitePreview:{status:"running"}});
 expect(saved).toHaveLength(1);expect(websiteEditMemory(saved,files,"p")).toContain('"unchanged":true');
 expect(websiteEditMemory(saved,[{...files[0]!,revision:"r2"}],"p")).toContain('"unchanged":false');expect(websiteEditMemory(saved,files,"other")).toBeNull();
 await rememberWebsiteEdit(store as never,{} as never,{} as never,{companyId:"c",projectId:"p",id:"s"},{status:"failed"});expect(saved).toHaveLength(1);
});
