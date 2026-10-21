// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { DevelopmentProcess } from "@npati/shared";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../business-workspace-shared", async importOriginal => ({ ...await importOriginal<object>(), api: mocks.api, useWorkspace: () => ({ overview: { currentBusiness: null }, loading: false }) }));
import { I18nProvider } from "../i18n";
import { BusinessChatPage } from "../BusinessWorkspace";
let root: Root | undefined;
afterEach(async () => { if(root) await act(async () => root!.unmount()); document.body.innerHTML="";vi.unstubAllGlobals();vi.restoreAllMocks(); });
it.each(["/c/child?company=company&project=project&developmentRoot=parent", "/c/child"])("keeps the project chat mounted across repeated edits from %s", async entry => {
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:vi.fn()});
  Object.defineProperty(HTMLElement.prototype,"scrollTo",{configurable:true,value:vi.fn()});
  const process: DevelopmentProcess = { id:"process",companyId:"company",projectId:"project",sessionId:"session",runId:"run",parentConversationId:"parent",conversationId:"child",name:"Company website",framework:"Next.js",inboxEnabled:true,status:"completed",previewUrl:"/preview/project",hidden:false,createdAt:"",updatedAt:"",progress:[{id:"build",stage:"build",title:"Building project",status:"completed",at:""}] };
  const card = { id:"project",projectId:"project",companyId:"company",name:process.name,status:"completed",kind:"code_project",previewUrl:process.previewUrl,lastBuildStatus:"ready" };
  mocks.api.mockImplementation(async (url: string) => url === "/chat/development/processes" ? {processes:[process]} : url === "/conversations" ? [] : url === "/conversations/child" ? {messages:[{id:"card",role:"assistant",content:process.name,projectCard:card,createdAt:""}]} : {});
  const requests: Record<string,unknown>[] = [];
  let releaseFirstResponse: () => void;
  const firstResponse = new Promise<void>(resolve => { releaseFirstResponse = resolve; });
  let changes: ReadableStreamDefaultController<Uint8Array>;
  let inboxPhase="settled";const queuedRequests: Record<string,unknown>[]=[];
  vi.stubGlobal("fetch",vi.fn(async (url: string, init?:RequestInit) => {
    if(url === "/api/chat/development/processes/stream") return new Response(new ReadableStream({start(c){changes=c;init?.signal?.addEventListener("abort",()=>c.close(),{once:true});}}));
    if(url.includes("/code/sessions/session/messages")) {
      if(init?.method === "POST") { const request=JSON.parse(String(init.body));queuedRequests.push(request);const receipt={id:"queued",requestId:request.requestId,text:request.text,target:"next-turn",status:"pending",revision:2,runId:null,createdAt:new Date().toISOString()};return new Response(JSON.stringify({revision:2,phase:"sealed",runId:"run",lastError:null,messages:[receipt],receipt}),{status:202}); }
      return new Response(JSON.stringify({revision:1,phase:inboxPhase,runId:"run",lastError:null,messages:[]}));
    }
    if(url.endsWith("/preview/status")) return new Response(JSON.stringify({isRunning:true}));
    if(url.endsWith("/preview/token")) return new Response(JSON.stringify({token:"preview-token"}));
    if(url === "/api/chat/stream") {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) await firstResponse;
      const result = {message:requests.length === 1 ? "Changed the button to green." : requests.length === 2 ? "Added the contact form." : "Changed the footer to blue.",conversationId:"child",projectCard:card,activeContext:{contextType:"project",companyId:"company",projectId:"project"}};
      return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('event: progress\ndata: {"routed":"code_runner","intent":"EDIT_CODE"}\n\nevent: code_session\ndata: {"companyId":"company","projectId":"project","sessionId":"session","inboxEnabled":true}\n\nevent: result\ndata: '+JSON.stringify(result)+'\n\n'));c.close();}}));
    }
    return new Response('{}');
  }));
  const host=document.createElement("div");document.body.append(host);root=createRoot(host);
  await act(async () => {root!.render(<MemoryRouter initialEntries={[entry]}><I18nProvider><BusinessChatPage neutralChat initialConversationId="child" initialPrompt="Make the button green" /></I18nProvider></MemoryRouter>);});
  expect(host.textContent).not.toContain("Developer Agent");expect(host.textContent).not.toContain("Edit in chat");
  const activityHeader=host.querySelector<HTMLButtonElement>(".codex-trace-row-header")!;
  await act(async()=>activityHeader.click());
  const stream=host.querySelector<HTMLElement>(".message-stream")!;
  Object.defineProperties(stream,{scrollHeight:{configurable:true,value:1000},scrollTop:{configurable:true,value:100},clientHeight:{configurable:true,value:300}});
  await act(async()=>stream.dispatchEvent(new Event("scroll",{bubbles:true})));
  const scrolling=vi.spyOn(stream,"scrollTo");scrolling.mockClear();
  process.progress=[...process.progress!,{id:"later",stage:"tool",title:"Read files",status:"completed",at:""}];
  await act(async()=>{changes!.enqueue(new TextEncoder().encode("event: change\ndata: {}\n\n"));await new Promise(resolve=>setTimeout(resolve,40));});
  expect(scrolling).not.toHaveBeenCalled();
  await act(async () => {host.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});
  // The server still reports the previous completed run while the next request is being admitted.
  expect(requests).toHaveLength(1);
  expect(host.querySelector(".chat-development-preview button")).toBeNull();
  await act(async()=>{changes!.enqueue(new TextEncoder().encode("event: change\ndata: {}\n\n"));await new Promise(resolve=>setTimeout(resolve,40));});
  expect(host.querySelector(".chat-development-preview button")).toBeNull();
  await act(async()=>{releaseFirstResponse!();await new Promise(resolve=>setTimeout(resolve,30));});
  expect(host.querySelector(".codex-trace-row-header")).toBe(activityHeader);
  expect(activityHeader.getAttribute("aria-expanded")).toBe("true");
  expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({contextType:"project",projectId:"project",companyId:"company",conversationId:"child"});
  expect(host.textContent).toContain("Changed the button to green.");
  expect(host.querySelector("textarea")).not.toBeNull();expect(host.textContent).not.toContain("Editing Company website");
  expect(host.querySelectorAll(".project-chat-card")).toHaveLength(0);
  expect(host.querySelectorAll(".chat-development-preview button")).toHaveLength(1);
  expect(new URL(window.location.href).searchParams.get("project")).toBe("project");
  const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(textarea,"Create a contact form on this website");textarea.dispatchEvent(new Event("input",{bubbles:true})); });
  await act(async () => {host.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});
  expect(requests).toHaveLength(2);expect(requests[1]).toMatchObject({projectId:"project",companyId:"company",conversationId:"child",message:"Create a contact form on this website"});
  expect(host.textContent).toContain("Added the contact form.");expect(host.querySelectorAll(".project-chat-card")).toHaveLength(0);
  const preview = host.querySelector(".chat-development-preview")!;
  const reply = [...host.querySelectorAll("article.assistant")].find(node=>node.textContent?.includes("Added the contact form."))!;
  expect(reply.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => preview.querySelector<HTMLButtonElement>("button")!.click());
  expect(document.querySelector('[aria-label="Preview of Company website"] iframe')).not.toBeNull();
  expect(host.textContent).not.toContain("Editing Company website");
  await act(async () => { setter.call(textarea,"Make the footer blue");textarea.dispatchEvent(new Event("input",{bubbles:true})); });
  await act(async () => {host.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});
  expect(requests).toHaveLength(3);expect(requests[2]).toMatchObject({projectId:"project",companyId:"company",conversationId:"child"});
  expect(host.textContent).toContain("Changed the footer to blue.");
  expect(document.querySelector('[aria-label="Preview of Company website"] iframe')).not.toBeNull();
  inboxPhase="sealed";await act(async()=>{window.dispatchEvent(new Event("focus"));await new Promise(resolve=>setTimeout(resolve,30));});
  for(const text of ["Pending coding messages","Next task","Add to current work"])expect(host.textContent).not.toContain(text);
  expect(host.querySelector(".code-pending-messages")).toBeNull();expect(host.querySelector(".chat-send-btn")).not.toBeNull();
  await act(async()=>{setter.call(textarea,"Make the footer red");textarea.dispatchEvent(new Event("input",{bubbles:true}));});
  await act(async()=>{host.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});
  expect(queuedRequests).toHaveLength(1);expect(queuedRequests[0]).toMatchObject({mode:"queue",text:"Make the footer red"});expect(requests).toHaveLength(3);
  expect(host.querySelector("article.user:last-of-type")?.textContent ?? host.textContent).toContain("Make the footer red");
  expect(host.querySelector(".code-pending-messages")).toBeNull();
  const traceCalls = () => vi.mocked(fetch).mock.calls.filter(([url])=>url==="/api/chat/development/processes/stream");
  const activeTrace = traceCalls().at(-1)![1]!.signal!;
  const hidden = vi.spyOn(document,"hidden","get").mockReturnValue(true);
  await act(async()=>document.dispatchEvent(new Event("visibilitychange")));
  expect(activeTrace.aborted).toBe(true);
  hidden.mockReturnValue(false);
  await act(async()=>document.dispatchEvent(new Event("visibilitychange")));
  expect(traceCalls().at(-1)![1]!.signal!.aborted).toBe(false);
});

it("keeps Preview outside user messages before and after reloading persisted chat history", async () => {
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:vi.fn()});
 Object.defineProperty(HTMLElement.prototype,"scrollTo",{configurable:true,value:vi.fn()});
 const card={id:"reload-project",projectId:"reload-project",companyId:"company",name:"Store",framework:"HTML/CSS",kind:"code_project",status:"completed",previewUrl:"/preview/store",lastBuildStatus:"ready"};
 const process:DevelopmentProcess={id:"reload-process",companyId:"company",projectId:"reload-project",parentConversationId:"parent",conversationId:"reload-chat",name:"Store",framework:"HTML/CSS",status:"completed",hidden:false,createdAt:"2026-10-21T10:00:00Z",updatedAt:"2026-10-21T10:02:00Z",previewUrl:"/preview/store",progress:[{id:"build",stage:"build",title:"Build complete",status:"completed",at:"2026-10-21T10:01:00Z"}]};
 const messages=[{id:"request",role:"user",content:"Create my store",projectCard:card,createdAt:"2026-10-21T10:00:00Z"},{id:"reply",role:"assistant",content:"The store is ready.",createdAt:"2026-10-21T10:02:00Z"}];
 let releaseProcesses:()=>void=()=>{};
 let loaded:Promise<void>;
 mocks.api.mockImplementation(async(url:string)=>{
  if(url==="/chat/development/processes"){await loaded;return {processes:[process]};}
  if(url==="/conversations")return [];
  if(url==="/conversations/reload-chat")return {messages:JSON.parse(JSON.stringify(messages))};
  return {};
 });
 vi.stubGlobal("fetch",vi.fn(async(_url:string,init?:RequestInit)=>new Response(new ReadableStream({start(c){init?.signal?.addEventListener("abort",()=>c.close(),{once:true});}}))));
 const host=document.createElement("div");document.body.append(host);
 for(let reload=0;reload<2;reload++){
  loaded=new Promise<void>(resolve=>{releaseProcesses=resolve;});
  root=createRoot(host);
  await act(async()=>{root!.render(<MemoryRouter initialEntries={["/c/reload-chat"]}><I18nProvider><BusinessChatPage neutralChat initialConversationId="reload-chat" /></I18nProvider></MemoryRouter>);});
  expect(host.querySelector("article.user")?.textContent).toContain("Create my store");
  expect(host.querySelector("article.user .coding-preview-trigger")).toBeNull();
  expect(host.querySelector("article.user .project-chat-card")).toBeNull();
  await act(async()=>releaseProcesses());
  const preview=host.querySelector(".chat-development-preview")!;
  const reply=host.querySelector("article.assistant")!;
  expect(host.querySelector("article.user .coding-preview-trigger")).toBeNull();
  expect(host.querySelectorAll(".coding-preview-trigger")).toHaveLength(1);
  expect(reply.compareDocumentPosition(preview)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async()=>root!.unmount());root=undefined;
 }
});