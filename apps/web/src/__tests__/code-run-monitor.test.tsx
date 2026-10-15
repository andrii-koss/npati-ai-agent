// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { monitorCodeRun, type DevelopmentProcessProgressItem as Event } from "@npati/shared";
import { CodeRunMonitor } from "../CodeRunMonitor";
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();document.body.innerHTML="";});
it("renders actual commands, expands output and reconnects after polling fails",async()=>{
  vi.useFakeTimers();Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  const at=new Date(Date.now()-600_000).toISOString();
  const event:Event={id:"command",runId:"run",tool:"code.shell.exec",stage:"tool",title:"Build",at,command:"npm run build",stdout:"Compile failed",stderr:"Invalid import",exitCode:1,status:"failed",durationMs:120};
  const run={id:"run",companyId:"co",projectId:"pr",task:"Site",requestedMode:"coding",status:"running",createdAt:at};
  const payload={run,summary:monitorCodeRun([event],{status:"running",startedAt:at}),events:[event],page:{nextCursor:null,total:1}};
  const fetcher=vi.spyOn(globalThis,"fetch").mockImplementation(async()=>new Response(JSON.stringify(payload),{status:200}));
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  try {
    await act(async()=>root.render(<CodeRunMonitor companyId="co" runId="run" isUk={false}/>));
    expect(host.textContent).toContain("No Progress");expect(host.textContent).toContain("Stalled");expect(host.textContent).toContain("npm run build");
    await act(async()=>host.querySelector<HTMLButtonElement>(".codex-trace-row-header")!.click());
    expect(host.textContent).toContain("Invalid import");expect(host.textContent).toContain("Compile failed");
    fetcher.mockRejectedValueOnce(Error("connection lost"));
    await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("connection lost");expect(host.textContent).toContain("Compile failed");
    await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});
    expect(host.querySelector('[role="alert"]')).toBeNull();expect(host.querySelector('.codex-trace-row-header')?.getAttribute('aria-expanded')).toBe("true");
    const filter=host.querySelector<HTMLSelectElement>('[aria-label="Event status"]')!;
    await act(async()=>{filter.value="completed";filter.dispatchEvent(new window.Event("change",{bubbles:true}));});
    expect(host.querySelectorAll('.codex-trace-row')).toHaveLength(0);
  }finally{await act(async()=>root.unmount());}
});
