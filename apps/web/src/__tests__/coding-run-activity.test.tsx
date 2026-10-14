// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DevelopmentProcess } from "@npati/shared";
import { ChatDevelopmentProgress } from "../ChatDevelopmentProgress";
import { I18nProvider } from "../i18n";
let root: Root | undefined;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;document.body.innerHTML="";vi.restoreAllMocks();});
it("updates one collapsed run row, retains all operations inside click-open history and hides service labels",async()=>{
  localStorage.setItem("npati_language","en");Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement("div");document.body.append(host);root=createRoot(host);
  let process:DevelopmentProcess={id:"process",companyId:"company",parentConversationId:"parent",name:"Site",framework:"Next.js",status:"running",hidden:false,createdAt:"",updatedAt:"",runId:"run",initialRunId:"run",responseLanguage:"uk",progress:[]};
  const steps=[{stage:"project",tool:"code.workspace"},{stage:"files",tool:"code.fs.edit"},{stage:"dependencies",command:"npm install"},{stage:"build",command:"npm run build"}];
  let header:Element|null=null;
  for(let index=0;index<steps.length;index++){
    process={...process,progress:[...(process.progress??[]).map(item=>({...item,status:"completed" as const})),{...steps[index]!,id:"operation"+index,runId:"run",title:"Internal action",at:new Date(index*1000).toISOString(),status:"running",agentId:"SYSTEM"}]};
    await act(async()=>root!.render(<I18nProvider><ChatDevelopmentProgress process={process}/></I18nProvider>));
    expect(host.querySelectorAll(".coding-run-activity")).toHaveLength(1);expect(host.querySelectorAll(".codex-trace-row-header")).toHaveLength(1);
    expect(host.querySelector(".coding-run-header")?.getAttribute("aria-expanded")).toBe("false");
    if(header)expect(host.querySelector(".coding-run-header")).toBe(header);header=host.querySelector(".coding-run-header");
  }
  expect(host.textContent).toContain("npm run build");expect(host.textContent).not.toContain("npm install");expect(host.querySelector(".coding-run-header")?.textContent).toContain("\u0412\u0438\u043a\u043e\u043d\u0443\u0454");
  await act(async()=>host.querySelector<HTMLButtonElement>(".coding-run-header")!.click());
  expect(host.querySelectorAll(".coding-operation-history .codex-trace-row")).toHaveLength(4);expect(host.textContent).toContain("npm install");
  const commandHeader=host.querySelectorAll<HTMLButtonElement>(".coding-operation-history .codex-trace-row-header")[2]!;
  commandHeader.focus();expect(document.activeElement).toBe(commandHeader);await act(async()=>commandHeader.click());expect(commandHeader.getAttribute("aria-expanded")).toBe("true");
  process={...process,status:"completed",runStatuses:{run:"completed"},progress:process.progress!.map(item=>({...item,status:"completed"}))};
  await act(async()=>root!.render(<I18nProvider><ChatDevelopmentProgress process={process}/></I18nProvider>));
  expect(host.querySelector(".coding-run-header")).toBe(header);expect(host.querySelector(".coding-run-header")?.textContent).toContain("4");
  for(const text of ["SYSTEM","Completed","NPATI Coding Agent"])expect(host.textContent).not.toContain(text);
  expect(host.querySelector(".codex-trace-status-pill")).toBeNull();
  await act(async()=>host.querySelector<HTMLButtonElement>(".coding-run-header")!.click());expect(host.querySelector(".codex-trace-collapse")?.getAttribute("aria-hidden")).toBe("true");
  await act(async()=>host.querySelector(".codex-trace-collapse")!.dispatchEvent(new Event("transitionend",{bubbles:true})));expect(host.querySelectorAll(".coding-operation-history")).toHaveLength(0);
});
it("keeps different runs independent and restores their histories from JSON",async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const process:DevelopmentProcess={id:"process",companyId:"c",parentConversationId:"parent",name:"Site",framework:"Next.js",status:"running",hidden:false,createdAt:"",updatedAt:"",initialRunId:"first",runId:"second",runStatuses:{first:"completed",second:"running"},progress:[{id:"a",stage:"build",title:"build",status:"completed",at:""},{id:"b",runId:"second",stage:"files",title:"edit",status:"running",at:""}]};
  await act(async()=>root!.render(<ChatDevelopmentProgress process={JSON.parse(JSON.stringify(process))}/>));
  expect(host.querySelectorAll(".coding-run-header")).toHaveLength(2);const headers=host.querySelectorAll<HTMLButtonElement>(".coding-run-header");await act(async()=>headers[0]!.click());expect(host.querySelector('.coding-run-history a')?.getAttribute("href")).toBe("/activity?runId=first");expect(headers[1]!.getAttribute("aria-expanded")).toBe("false");
});

it("offers the existing Send button for a new queued request during coding and preserves Stop for an empty draft",async()=>{
  const { BusinessChatComposer }=await import("../business-workspace-composer");const {renderToStaticMarkup}=await import("react-dom/server");
  const props: import("../business-workspace-composer").BusinessChatComposerProps={input:"Change the footer",setInput:()=>{},attachments:[],setAttachments:()=>{},draftVersion:{current:0},sending:true,codeInbox:{active:true},inboxSubmitting:false,contextSwitcher:null,noMemory:false,ttsEnabled:false,chatMode:"none",handleModeChange:()=>{},ttsVoice:"",handleTtsVoiceChange:()=>{},generateSpeechForInput:async()=>{},isGeneratingSpeech:false,sendOnEnter:()=>{},submit:async()=>{},business:null,t:(key:string)=>key,setNotice:()=>{},streamControllerRef:{current:null}};
  const active=renderToStaticMarkup(<BusinessChatComposer {...props}/>);expect(active).toContain("chat-send-btn");expect(active).not.toContain("code-pending-messages");expect(active).not.toContain("codeInbox.queue");
  expect(renderToStaticMarkup(<BusinessChatComposer {...{...props,input:""}}/>)).toContain("chat-stop-btn");
});
