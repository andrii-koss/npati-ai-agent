import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SharedProjectRuntimeProvider } from "../apps/agent-api/src/shared-project-runtime-provider";
import { describe, expect, it } from "vitest";
import { projectRuntimeCommandPort, projectRuntimeWorkspaceCommand } from "../apps/agent-api/src/shared-project-runtime-provider";

describe("shared runtime project port routing", () => {
  it("maps legacy workspace paths to the selected project without matching other names", () => {
    expect(projectRuntimeWorkspaceCommand("cp '/workspace/.npati-runtime/import/.' /workspace/ && cat /workspace-not-a-path", "/projects/selected"))
      .toBe("cp '/projects/selected/.npati-runtime/import/.' /projects/selected/ && cat /workspace-not-a-path");
  });
  it.each([
    ["npm run dev", "npm run dev -- --port 3002"],
    ["npm run dev -- --host 0.0.0.0", "npm run dev -- --host 0.0.0.0 --port 3002"],
    ["npx next dev --port 3000", "npx next dev --port 3002"],
    ["npx vite --host 0.0.0.0", "npx vite --host 0.0.0.0 --port 3002"],
    ["npx expo start --web --port 8081", "npx expo start --web --port 3002"],
    ["npm run export && npx -y serve -s dist -l 3000", "npm run export && npx -y serve -s dist -l 3002"],
    ["node server.js", "node server.js"],
    ["python3 -m http.server 8000", "python3 -m http.server 3002"],
    ["php -S 0.0.0.0:8000", "php -S 0.0.0.0:3002"],
  ])("assigns selected project port to %s", (command, expected) => {
    expect(projectRuntimeCommandPort(command, 3002)).toBe(expected);
  });
});

it("round-trips real PNG bytes and UTF-8 source through the shared runtime transport scripts",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"npati-binary-transport-"));
 try{
 const provider=Object.create(SharedProjectRuntimeProvider.prototype) as SharedProjectRuntimeProvider;
 Object.assign(provider,{entry:async()=>({}),collect:async(_entry:unknown,_executable:string,args:string[],input:string)=>({exitCode:0,stdout:execFileSync(process.execPath,args,{cwd:root,input,encoding:"utf8"}),stderr:""})});
 const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,255,128]);
 const scope={workspaceId:"w",userId:"u",companyId:"c",projectId:"p"};
 await provider.uploadFiles(scope,"sandbox",[{path:"reference.png",content:bytes.toString("base64"),encoding:"base64"},{path:"page.ts",content:"export const title = 'photo';"}]);
 expect(await readFile(path.join(root,"reference.png"))).toEqual(bytes);
 const downloaded=await provider.downloadFiles(scope,"sandbox");
 expect(downloaded).toContainEqual({path:"reference.png",content:bytes.toString("base64"),encoding:"base64"});
 expect(downloaded).toContainEqual({path:"page.ts",content:"export const title = 'photo';"});
 }finally{await rm(root,{recursive:true,force:true});}
});
