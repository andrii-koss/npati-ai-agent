import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createFrameworkScaffold } from "../apps/agent-api/src/project-framework-scaffold";
import { minimalNextScaffold, finalizeMinimalScaffold } from "../apps/agent-api/src/project-minimal-scaffold";
import { createMobileAppScaffold } from "../packages/shared/src/index";

const frameworks = ["Next.js","React + Vite","Vue 3 + Vite","Nuxt","SvelteKit","Astro","Angular","Remix","Express","Fastify","NestJS","Expo"];
const queue = [...frameworks], locks: Record<string, unknown> = JSON.parse(await readFile("apps/agent-api/src/project-framework-locks.json","utf8"));
const npmCli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
async function generate(framework: string) {
 const name = "npati-framework";
 const files = framework === "Next.js" ? minimalNextScaffold(name) : framework === "Expo"
   ? finalizeMinimalScaffold(createMobileAppScaffold({name,slug:name,scheme:"npati-test"}).files, "Expo")
   : createFrameworkScaffold({projectName:name,prompt:"",framework});
 const directory = path.resolve("artifacts/framework-lock-generation", framework.replace(/[^a-z0-9]/gi,"-"));
 await mkdir(directory,{recursive:true});
 await writeFile(path.join(directory,"package.json"), files["package.json"]!);
 const output = await new Promise<{code:number|null;log:string}>((resolve,reject)=>{
  const child = spawn(process.execPath,[npmCli,"install","--package-lock-only","--ignore-scripts","--no-audit","--no-fund"],{cwd:directory,windowsHide:true});
  let log="";child.stdout.on("data",data=>log+=data);child.stderr.on("data",data=>log+=data);
  const timer=setTimeout(()=>child.kill(),180000);
  child.on("error",reject);child.on("close",code=>{clearTimeout(timer);resolve({code,log});});
 });
 await writeFile(path.join(directory,"install.log"),output.log);
 if(output.code!==0)throw Error(framework+": "+output.log.slice(-1800));
 locks[framework]=JSON.parse(await readFile(path.join(directory,"package-lock.json"),"utf8"));
 console.log(framework+": locked");
}
await Promise.all(Array.from({length:3},async()=>{while(queue.length){const framework=queue.shift()!;await generate(framework);}}));
await writeFile("apps/agent-api/src/project-framework-locks.json",JSON.stringify(locks,null,2)+"\n");
console.log("Pinned "+Object.keys(locks).length+" framework dependency graphs");
