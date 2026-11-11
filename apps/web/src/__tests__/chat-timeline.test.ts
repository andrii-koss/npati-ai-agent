import { describe, expect, it } from "vitest";
import { activitySlots, codingActivityRuns, codingActivityStages, mergeConversationMessages, chatTimeline, normalizeActivity, nearChatBottom } from "../chat-timeline";
import type { Message } from "../business-workspace-cards";
const at = (n: number) => new Date(1000 * n).toISOString();
const messages: Message[] = [ {id:"u1",role:"user",content:"Create site",createdAt:at(1)}, {id:"a1",role:"assistant",content:"Ready",createdAt:at(4)}, {id:"u2",role:"user",content:"Change button",createdAt:at(5)}, {id:"a2",role:"assistant",content:"Changed",createdAt:at(8)} ];
const event = (id: string, time: number) => ({id,stage:"tool",title:"Run",at:at(time),status:"running",conversationId:"chat",runId:id});
describe("chat chronological activity", () => {
  it("interleaves each run with its own user/assistant turn and keeps original message order", () => {
    const slots = activitySlots(messages,[event("run2",6),event("run1",2)],"chat");
    expect(slots.get(1)?.map(x=>x.id)).toEqual(["run1"]); expect(slots.get(3)?.map(x=>x.id)).toEqual(["run2"]);
    expect(messages.map(x=>x.id)).toEqual(["u1","a1","u2","a2"]);
    expect(chatTimeline(messages,[event("run2",6),event("run1",2)],"chat").map(entry => entry.kind === "message" ? entry.message.id : entry.item.id)).toEqual(["u1","run1","a1","u2","run2","a2"]);
  });
  it("deduplicates replay and updates one call without moving historical activity", () => {
    const slots = activitySlots(messages,[event("r1",2),event("r2",6),{...event("r1",2),status:"completed",result:"ok"}],"chat");
    expect(slots.get(1)).toHaveLength(1);expect(slots.get(1)?.[0]).toMatchObject({id:"r1",status:"completed",result:"ok"});
    expect(activitySlots(messages.slice(0,3),[event("r1",2)],"chat").get(1)?.[0]?.id).toBe("r1");
  });
  it("orders concurrent operations with durable sequence and restores from JSON", () => {
    const events = [{...event("b",2),sequence:2},{...event("a",2),sequence:1}];
    expect(activitySlots(messages,JSON.parse(JSON.stringify(events)),"chat").get(1)?.map(x=>x.id)).toEqual(["a","b"]);
    expect(activitySlots(messages,[{...event("wrong",2),conversationId:"another"}],"chat").size).toBe(0);
  });
  it("rejects malformed events and fields, redacts secrets and preserves lifecycle states", () => {
    expect(normalizeActivity([null,{}, {id:"bad",stage:[],title:"oops",at:""}])).toEqual([]);
    const rows=normalizeActivity([{...event("x",2),status:"awaiting_approval",command:"npm run build token=secret",durationMs:NaN,stdout:{nested:"bad"}},{...event("y",3),status:"cancelled"}]);
    expect(rows[0]).toMatchObject({status:"awaiting_approval",command:"npm run build token=[REDACTED]"});expect(rows[0]?.stdout).toBeUndefined();expect(rows[0]?.durationMs).toBeUndefined();expect(rows[1]?.status).toBe("cancelled");
  });
  it("follows live output near the end and respects a reader in history", () => {
    expect(nearChatBottom({scrollHeight:1000,scrollTop:610,clientHeight:300})).toBe(true);
    expect(nearChatBottom({scrollHeight:1000,scrollTop:100,clientHeight:300})).toBe(false);
  });
});

it("preserves factual multi-file changes and structured test counts without fabricating missing details", () => {
  const rows = normalizeActivity([{...event("patch",2),files:[{path:"app/page.tsx",action:"modified",linesAdded:4,linesRemoved:2,diff:"+token=secret"},{path:"app/contact.tsx",action:"created"},null],tests:{total:24,passed:23,failed:1,skipped:0}}]);
  expect(rows[0]?.files).toHaveLength(2);expect(rows[0]?.files?.[0]?.diff).toBe("+token=[REDACTED]");expect(rows[0]?.files?.[1]?.linesAdded).toBeUndefined();expect(rows[0]?.tests?.failed).toBe(1);
});

it("keeps preparing and queued runs visible instead of collapsing them to pending", () => {
  const process: import("@npati/shared").DevelopmentProcess = { companyId:"c", parentConversationId:"parent", name:"Site", framework:"HTML/CSS", hidden:false, createdAt:at(1), updatedAt:at(2), id:"p", initialRunId:"r1", runId:"r1", status:"preparing", runStatuses:{r1:"preparing"}, runStartedAts:{r1:at(1)} };
  expect(codingActivityRuns([], process).map(group=>group.status)).toEqual(["preparing"]);
  expect(codingActivityStages([], process)).toHaveLength(1);
  expect(codingActivityRuns([], { ...process, status:"queued", runStatuses:{r1:"queued"} }).map(group=>group.status)).toEqual(["queued"]);
});

it("anchors a whole run once, preserves completed runs and shows actual running state before the first tool",()=>{
 const process: import("@npati/shared").DevelopmentProcess = {companyId:"c",parentConversationId:"parent",name:"Site",framework:"Next.js",hidden:false,createdAt:at(1),updatedAt:at(6),id:"p",initialRunId:"r1",runId:"r2",status:"running",runStatuses:{r1:"completed",r2:"running"},runStartedAts:{r2:at(6)},runLanguages:{r2:"uk"}};
 const entries=chatTimeline(messages,[{...event("a",2),runId:"r1",status:"completed"},{...event("b",3),runId:"r1",status:"completed"}],"chat",process);
 expect(entries.filter(entry=>entry.kind==="activity")).toHaveLength(2);
 expect(codingActivityRuns([{...event("a",2),runId:"r1",status:"completed"}],process).map(group=>group.status)).toEqual(["completed","running"]);
 const merged=mergeConversationMessages(messages,[{id:"queued",role:"user",content:"More changes",createdAt:at(6)}]);
 expect(mergeConversationMessages(merged,[{id:"queued",role:"user",content:"More changes",createdAt:at(6)}])).toHaveLength(5);
});

it.each(["en","uk","de","fr","es","it","pl","pt","nl","tr","ru","zh","ja","ko","ar","hi"])("provides request-language summaries and command labels for %s",async language=>{
 const {executionTraceText}=await import("../i18n");expect(executionTraceText(language,"runningCommand")).toContain("{{command}}");expect(executionTraceText(language,"operationsDone")).toContain("{{count}}");if(language!=="en")expect(executionTraceText(language,"working")).not.toBe(executionTraceText("en","working"));
}, 30_000); // The first language loads every locale module; under a full parallel run that alone passed 5 s.

it("keeps the running row anchored when the first tool arrives after a public assistant update",()=>{
 const process: import("@npati/shared").DevelopmentProcess={id:"p",companyId:"c",parentConversationId:"parent",name:"Site",framework:"Next.js",hidden:false,createdAt:at(1),updatedAt:at(6),runId:"r",initialRunId:"initial",status:"running",runStatuses:{r:"running"},runStartedAts:{r:at(2)}};
 const before=codingActivityRuns([],process)[0]!;const after=codingActivityRuns([{...event("call",3),runId:"r"}],process)[0]!;expect(after.id).toBe(before.id);expect(after.at).toBe(before.at);
});

it("splits actual actions across public commentary phases and moves activity to the current phase",()=>{
 const process:import("@npati/shared").DevelopmentProcess={id:"p",companyId:"c",parentConversationId:"parent",name:"Site",framework:"Next.js",hidden:false,createdAt:at(0),updatedAt:at(12),runId:"r",initialRunId:"r",status:"running",runStatuses:{r:"running",empty:"completed"}};
 const operations=[1,3,4,6,7,9,11].map((time,index)=>({...event("tool-"+index,time),runId:"r",status:index===6?"running":"completed",command:index===6?"npm run build":undefined}));
 const comments=[2,5,8,10].map((time,index)=>({...event("comment-"+index,time),runId:"r",kind:"assistant_message" as const,stage:"planning",title:"Actual progress "+index,status:"completed"}));
 const rows=[...operations,...comments]; const stages=codingActivityStages(rows,process);
 expect(stages.map(stage=>stage.items.length)).toEqual([1,2,2,1,1]);expect(stages.map(stage=>stage.status)).toEqual(["completed","completed","completed","completed","running"]);
 expect(stages.flatMap(stage=>stage.items.map(item=>item.id)).sort()).toEqual(operations.map(item=>item.id).sort());
 const timeline=chatTimeline([],rows,"chat",process);expect(timeline.filter(entry=>entry.kind==="activity").map(entry=>entry.kind==="activity"&&entry.run?entry.run.items.length:entry.kind==="activity"?entry.item.title:"" )).toEqual([1,"Actual progress 0",2,"Actual progress 1",2,"Actual progress 2",1,"Actual progress 3",1]);
 const settled={...process,status:"completed" as const,runStatuses:{r:"completed",empty:"completed"}};
 expect(codingActivityStages(rows.map(item=>({...item,status:"completed"})),settled).map(stage=>stage.items.length)).toEqual([1,2,2,1,1]);
 expect(codingActivityStages([],settled)).toEqual([]);
 expect(codingActivityStages(JSON.parse(JSON.stringify(rows)),process).map(stage=>stage.id)).toEqual(stages.map(stage=>stage.id));
});
it("orders commentary before its phase when the events share a timestamp",()=>{
 const process:import("@npati/shared").DevelopmentProcess={id:"p",companyId:"c",parentConversationId:"parent",name:"Site",framework:"Next.js",hidden:false,createdAt:at(1),updatedAt:at(2),runId:"r",initialRunId:"r",status:"running"};
 const rows=[{...event("comment",2),runId:"r",kind:"assistant_message" as const,sequence:1000,title:"Reading next"},{...event("read",2),runId:"r",sequence:1001}];
 const entries=chatTimeline([],rows,"chat",process);expect(entries.map(entry=>entry.kind==="activity"?entry.run?"phase":"comment":"message")).toEqual(["comment","phase"]);
});

it("preserves flag-suspended run state after reload instead of inferring running from old events", () => {
  const process: import("@npati/shared").DevelopmentProcess = {
    id: "p", companyId: "c", parentConversationId: "chat", name: "Site", framework: "Next.js", hidden: false,
    createdAt: at(1), updatedAt: at(3), runId: "r", initialRunId: "r", status: "suspended_by_flag",
    runStatuses: { r: "suspended_by_flag" },
  };
  const groups = codingActivityRuns([{ ...event("tool", 2), runId: "r" }], JSON.parse(JSON.stringify(process)));
  expect(groups[0]?.status).toBe("suspended_by_flag");
});
