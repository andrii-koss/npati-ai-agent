// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DevelopmentProcess } from "@npati/shared";
import { ChatDevelopmentProgress } from "../ChatDevelopmentProgress";
import { I18nProvider } from "../i18n";
let root: Root | undefined;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;document.body.innerHTML="";vi.restoreAllMocks();});
it("updates one collapsed run row, retains actual operations inside click-open history and hides service labels",async()=>{
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
  expect(host.querySelectorAll(".coding-operation-history .codex-trace-row")).toHaveLength(3);expect(host.textContent).toContain("npm install");
  const commandHeader=host.querySelectorAll<HTMLButtonElement>(".coding-operation-history .codex-trace-row-header")[2]!;
  commandHeader.focus();expect(document.activeElement).toBe(commandHeader);await act(async()=>commandHeader.click());expect(commandHeader.getAttribute("aria-expanded")).toBe("true");
  process={...process,status:"completed",runStatuses:{run:"completed"},progress:process.progress!.map(item=>({...item,status:"completed"}))};
  await act(async()=>root!.render(<I18nProvider><ChatDevelopmentProgress process={process}/></I18nProvider>));
  expect(host.querySelector(".coding-run-header")).toBe(header);expect(host.querySelector(".coding-run-header")?.textContent).toContain("3");
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

it("expands real command output and code changes inside the run instead of metadata-only panels",async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const process:DevelopmentProcess={id:"p",companyId:"c",parentConversationId:"parent",name:"Site",framework:"Next.js",status:"completed",hidden:false,createdAt:"",updatedAt:"",runId:"run",initialRunId:"run",progress:[{id:"read",runId:"run",stage:"tool",tool:"code.fs.read",title:"Read",at:"2026-10-14T10:00:00Z",status:"completed",file:"app/page.tsx",fileContent:"export default function Page() { return <h1>Site</h1>; }"},{id:"edit",runId:"run",stage:"tool",tool:"code.fs.edit",title:"Edit",at:"2026-10-14T10:00:01Z",status:"completed",arguments:'{"path":"app/page.tsx","newText":"New"}',diff:"-Old\n+New"},{id:"build",runId:"run",stage:"build",title:"Build",at:"2026-10-14T10:00:02Z",status:"completed",command:"npm run build",stdout:"Compiled successfully",stderr:"",exitCode:0}]};
  await act(async()=>root!.render(<ChatDevelopmentProgress process={process}/>));await act(async()=>host.querySelector<HTMLButtonElement>(".coding-run-header")!.click());
  for(const header of host.querySelectorAll<HTMLButtonElement>(".coding-operation-history .codex-trace-row-header"))await act(async()=>header.click());
  const panels=host.querySelectorAll(".codex-trace-detail-panel");expect(panels).toHaveLength(3);
  expect(panels[0]!.textContent).toContain("export default function Page()");expect(panels[1]!.textContent).toContain("-Old\n+New");expect(panels[1]!.textContent).toContain('"newText":"New"');expect(panels[2]!.textContent).toContain("npm run build");expect(panels[2]!.textContent).toContain("Compiled successfully");expect(panels[2]!.textContent).toContain("0");expect(host.querySelector('button[title="Copy command"]')).not.toBeNull();
});

it("shows Preview only with settled activity and keeps an already open iframe during the next edit",async()=>{
  const {MemoryRouter}=await import("react-router-dom");const {ChatDevelopmentPreview}=await import("../ChatDevelopmentProgress");
  vi.spyOn(globalThis,"fetch").mockImplementation(async input=>new Response(JSON.stringify(String(input).endsWith("/status")?{isRunning:true}:{token:"test-preview-token"}),{status:200}));
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const process:DevelopmentProcess={id:"p",companyId:"c",projectId:"project",parentConversationId:"parent",name:"Site",framework:"Next.js",status:"running",hidden:false,createdAt:"",updatedAt:"",runId:"run",initialRunId:"run",previewUrl:"/previous-preview",progress:[{id:"build",runId:"run",stage:"build",title:"Build",at:"",status:"running",command:"npm run build"}]};
  const render=async(p:DevelopmentProcess,busy=false)=>act(async()=>root!.render(<MemoryRouter><ChatDevelopmentProgress process={p}/><ChatDevelopmentPreview process={p} busy={busy}/></MemoryRouter>));
  await render(process);expect(host.querySelector(".chat-development-preview button")).toBeNull();expect(host.querySelector(".research-active-text")).not.toBeNull();
  const done={...process,status:"completed" as const,progress:process.progress!.map(e=>({...e,status:"completed" as const}))};
  await render(done);expect(host.querySelector(".research-active-text")).toBeNull();const button=host.querySelector<HTMLButtonElement>(".chat-development-preview button")!;expect(button).not.toBeNull();expect(button.querySelector(".coding-preview-framework")?.textContent).toBe("Next.js");await act(async()=>button.click());
  const iframe=document.querySelector('[aria-label="Preview of Site"] iframe');expect(iframe).not.toBeNull();
  await render(done,true);expect(host.querySelector(".chat-development-preview button")).toBeNull();expect(document.querySelector('[aria-label="Preview of Site"] iframe')).toBe(iframe);
  await render(process);expect(host.querySelector(".chat-development-preview button")).toBeNull();expect(document.querySelector('[aria-label="Preview of Site"] iframe')).toBe(iframe);
  await render(done);expect(host.querySelector(".chat-development-preview button")).not.toBeNull();expect(document.querySelector('[aria-label="Preview of Site"] iframe')).toBe(iframe);
});

it("renders a standalone public update without creating zero-operation rows from other Run metadata",async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const process:DevelopmentProcess={id:"p",companyId:"c",parentConversationId:"parent",name:"Site",framework:"Next.js",hidden:false,status:"completed",createdAt:"",updatedAt:"",runId:"r",initialRunId:"r",runStatuses:{r:"completed",other:"completed"}};
  await act(async()=>root!.render(<ChatDevelopmentProgress process={process} items={[{id:"message",stage:"planning",kind:"assistant_message",runId:"r",title:"Now editing the files",at:""}]}/>));
  expect(host.textContent).toBe("Now editing the files");expect(host.querySelectorAll(".coding-run-activity")).toHaveLength(0);
});

it("renders successive phases around real public updates and stops the previous phase animation",async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const at=(n:number)=>new Date(n*1000).toISOString();const process:DevelopmentProcess={id:"p",companyId:"c",parentConversationId:"parent",name:"Site",framework:"Next.js",hidden:false,status:"running",createdAt:at(0),updatedAt:at(5),runId:"r",initialRunId:"r",runStatuses:{r:"running",old:"completed"},progress:[{id:"read",stage:"tool",tool:"code.fs.read",runId:"r",title:"Read",file:"app/page.tsx",at:at(1),status:"completed"},{id:"update",kind:"assistant_message",stage:"planning",runId:"r",title:"Now editing the page",at:at(2),status:"completed"},{id:"edit",stage:"tool",tool:"code.fs.edit",runId:"r",title:"Edit",file:"app/page.tsx",at:at(3),status:"running"}]};
  await act(async()=>root!.render(<ChatDevelopmentProgress process={process}/>));
  const rows=host.querySelectorAll(".coding-run-activity");expect(rows).toHaveLength(2);expect(rows[0]!.querySelector(".research-active-text")).toBeNull();expect(rows[1]!.querySelector(".research-active-text")).not.toBeNull();
  const message=[...host.querySelectorAll("article")].find(e=>e.textContent==="Now editing the page")!;expect(rows[0]!.compareDocumentPosition(message)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();expect(message.compareDocumentPosition(rows[1]!)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  for(const button of host.querySelectorAll<HTMLButtonElement>(".coding-run-header"))await act(async()=>button.click());
  expect(rows[0]!.querySelectorAll(".coding-operation-history .codex-trace-row")).toHaveLength(1);expect(rows[1]!.querySelectorAll(".coding-operation-history .codex-trace-row")).toHaveLength(1);
});

it("shows factual per-turn token usage shared by tools and does not count model metadata as an operation",async()=>{
  const {AgentExecutionTrace}=await import("../AgentExecutionTrace");Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const usage={id:"r:model:1",turn:1,inputTokens:120,outputTokens:30,totalTokens:150,toolCallIds:["a","b"],model:"test-model",costUsd:0.01};
  await act(async()=>root!.render(<AgentExecutionTrace items={[{id:"r:a",runId:"r",stage:"tool",tool:"code.fs.apply_patch",title:"patch",at:"",status:"completed",dryRun:true,modelUsage:usage}]}/>));await act(async()=>host.querySelector<HTMLButtonElement>(".codex-trace-row-header")!.click());
  expect(host.textContent).toContain("120");expect(host.textContent).toContain("30");expect(host.textContent).toContain("150");expect(host.textContent).toContain("Shared by 2 tool calls");expect(host.textContent).toContain("Dry run: changes not applied");expect(host.textContent).not.toContain("File updated");
  const {codingActivityStages}=await import("../chat-timeline");const process:DevelopmentProcess={id:"p",companyId:"c",parentConversationId:"parent",name:"Site",framework:"Next.js",hidden:false,status:"completed",createdAt:"",updatedAt:"",runId:"r",initialRunId:"r"};
  const stages=codingActivityStages([{id:"r:usage",runId:"r",stage:"model_usage",title:"Usage",at:"",status:"completed",modelUsage:usage},{id:"r:a",runId:"r",stage:"tool",title:"read",at:"",status:"completed",modelUsage:usage},{id:"r:b",runId:"r",stage:"tool",title:"read",at:"",status:"completed",modelUsage:usage}],process);
  expect(stages[0]!.items).toHaveLength(2);expect(stages[0]!.usage).toHaveLength(1);
});
