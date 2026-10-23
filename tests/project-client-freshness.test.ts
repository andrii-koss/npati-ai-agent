import {expect,it} from "vitest";
import {createProjectClient} from "../packages/project-client/src/index";
it("reads a changed row through a framework-like fetch cache instead of serving the previous data",async()=>{
 let name="ORIGINAL";const cache=new Map<string,string>();const modes:unknown[]=[];
 const fetcher:typeof fetch=async(input,init)=>{const url=String(input);modes.push(init?.cache);let body=JSON.stringify({data:[{id:"row",name}]});if(init?.cache!=="no-store"){body=cache.get(url)??body;cache.set(url,body);}return new Response(body,{status:200,headers:{"content-type":"application/json"}});};
 const client=createProjectClient({apiUrl:"https://project.example/v1/projects/test",publishableKey:"test-publishable",fetch:fetcher});expect((await client.from("products").list()).data[0].name).toBe("ORIGINAL");name="UPDATED";expect((await client.from("products").list()).data[0].name).toBe("UPDATED");expect(modes).toEqual(["no-store","no-store"]);
});
it("defaults internal raw requests to fresh data while preserving an explicit cache choice and external fetch behavior",async()=>{
 const modes:unknown[]=[];const fetcher:typeof fetch=async(_url,init)=>{modes.push(init?.cache);return new Response("{}",{headers:{"content-type":"application/json"}});};const client=createProjectClient({apiUrl:"https://project.example/v1/projects/test",fetch:fetcher});await client.fetchRaw("/data/products");await client.fetchRaw("/data/products",{cache:"force-cache"});await client.fetchRaw("https://assets.example/image");expect(modes).toEqual(["no-store","force-cache",undefined]);
});
