// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ActivityPage } from "./ActivityPage";
vi.mock("./AuthContext", () => ({ getStoredAuthToken: () => "V6TEST16-pagination-unit" }));
vi.mock("./i18n", async () => ({ I18nContextRef: (await import("react")).createContext(null), executionTraceText: (s: string) => s, useTranslation: () => ({ language: "en", t: (s: string) => s }) }));
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { if(root) await act(async () => root!.unmount()); host?.remove(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });
it("keeps a company beyond page one selectable and dispatches only to that company", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.clear(); sessionStorage.clear();
  const requested: Array<{url:string;method?:string}> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url=String(input); requested.push({url,method:init?.method});
    const body = /\/companies\?/.test(url)
      ? url.includes("cursor=") ? {companies:[{id:"V6TEST16-late",name:"V6TEST16 late company"}],pagination:{nextCursor:null}}
        : {companies:Array.from({length:50},(_,i)=>({id:`early-${i}`,name:`Early ${i}`})),pagination:{nextCursor:"V6TEST16-next"}}
      : init?.method === "POST" ? {error:{message:"V6TEST controlled refusal"}}
      : {runs:[],nextCursor:null};
    return new Response(JSON.stringify(body),{status:init?.method === "POST" ? 400 : 200});
  }));
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  await act(async()=>{root!.render(<MemoryRouter><ActivityPage /></MemoryRouter>);});
  await act(async()=>host!.querySelector<HTMLButtonElement>("#activity-company-select")!.click());
  const lateCompany = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent === "V6TEST16 late company");
  expect(lateCompany).toBeDefined();
  await act(async()=>lateCompany!.click());
  const input=host.querySelector<HTMLInputElement>("input.activity-task-input")!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"V6TEST16 dispatch to late company");input.dispatchEvent(new Event("input",{bubbles:true}));});
  await act(async()=>host!.querySelector<HTMLButtonElement>(".activity-dispatch-submit-btn")!.click());
  expect(requested.filter(r=>r.method === "POST").map(r=>r.url)).toEqual(["/api/companies/V6TEST16-late/runs"]);
});
