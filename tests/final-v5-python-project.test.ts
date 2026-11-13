import { expect, it } from "vitest";
import { canonicalFrameworkName, extractFramework } from "@npati/shared";
import { createFrameworkScaffold } from "../apps/agent-api/src/project-framework-scaffold";
import { isCodeChatWebsite } from "../apps/agent-api/src/code-chat-website";
import { ProjectPreviewService } from "../apps/agent-api/src/project-preview-service";
it("preserves an explicitly requested Pygame desktop technology",()=>{expect(extractFramework('Створи Python Pygame гру, не підмінюй її вебгрою')).toBe('Pygame');expect(canonicalFrameworkName('Python / Pygame')).toBe('Pygame');});
it("scaffolds Python metadata without an HTML or Node application",()=>{const files=createFrameworkScaffold({framework:'Pygame',projectName:'Stars',prompt:'Catch stars with arrows'});expect(files['requirements.txt']).toContain('pygame');expect(files['README.md']).toContain('GUI');expect(files['index.html']).toBeUndefined();expect(files['package.json']).toBeUndefined();});
it("does not finalize desktop code as an HTTP website",()=>{expect(isCodeChatWebsite({type:'code_project',framework:'Pygame'})).toBe(false);expect(isCodeChatWebsite({type:'code_project',framework:'React + Vite'})).toBe(true);});
// V6 step 08 (owner decision): a Pygame game's Preview is its window, streamed from the Sandbox's virtual display; the old
// 409 "desktop_preview_unsupported" is gone. The venv sees the Sandbox's pygame, and no web substitute is started.
it("starts a Pygame Preview as the streamed game window, with a venv that sees the system pygame",async()=>{
  const commands:string[]=[];let started="";
  const project={id:"project",companyId:"company",framework:"Pygame",status:"active",sandboxId:"sbx"};
  const sandbox={exposePort:async()=>({port:6080}),stopRecordedPreview:async()=>undefined,supportsPreviewProxy:()=>false,
    execute:async(_c:unknown,_co:string,input:{command:string})=>{commands.push(input.command);return{exitCode:input.command.startsWith("test -x")?1:0};},
    process:async(_c:unknown,_co:string,input:{action:string;command?:string})=>{if(input.action==="start")started=input.command??"";return{processId:"proc-1"};}};
  const projects={get:async()=>project,updatePreview:async()=>project};
  const workspace={listFiles:async()=>[{path:"main.py",type:"file"},{path:"requirements.txt",type:"file"}],readFile:async()=>({content:"pygame\n"})};
  const preview=new ProjectPreviewService(projects as never,{} as never,workspace as never,sandbox as never,"test");
  const result=await preview.startPreview({workspaceId:"w",userId:"u",permissions:[]} as never,"company","project");
  expect(started).toBe("python3 /opt/npati-qa/pygame-stream.py --port $PORT");
  expect(result).toMatchObject({status:"running",port:6080,framework:"Pygame"});
  expect(commands).toContain("python3 -m venv --system-site-packages .venv");
  expect(commands.some(command=>/http\.server|npm|vite/.test(command))).toBe(false);
});
