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
