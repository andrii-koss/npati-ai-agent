import type { DevelopmentProcess, DevelopmentProcessProgressItem } from "@npati/shared";
import { sanitizeExecutionTrace } from "@npati/shared";
import type { Message } from "./business-workspace-cards";
/** Reject malformed presentation payloads; keep runtime identity across replay/status updates. */
export function normalizeActivity(value: unknown): DevelopmentProcessProgressItem[] {
  if (!Array.isArray(value)) return [];
  const valid = new Map<string, DevelopmentProcessProgressItem>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id || typeof raw.stage !== "string" || typeof raw.title !== "string" || typeof raw.at !== "string") continue;
    const item: DevelopmentProcessProgressItem = { id: raw.id, stage: raw.stage, title: sanitizeExecutionTrace(raw.title), at: raw.at };
    for (const field of ["tool", "command", "arguments", "fileContent", "file", "cwd", "result", "stdout", "stderr", "error", "errorCode", "agentId", "runId", "conversationId", "diff", "language"] as const) if (typeof raw[field] === "string") item[field] = sanitizeExecutionTrace(raw[field]);
    for (const field of ["durationMs", "sequence", "exitCode", "linesAdded", "linesRemoved"] as const) if (typeof raw[field] === "number" && Number.isFinite(raw[field])) item[field] = raw[field];
    if (["pending", "active", "running", "completed", "failed", "cancelled", "waiting_for_approval", "awaiting_approval"].includes(raw.status)) item.status = raw.status;
    if (["created", "modified", "deleted"].includes(raw.fileChange)) item.fileChange = raw.fileChange;
    if (raw.kind === "assistant_message") item.kind = raw.kind;
    if (Array.isArray(raw.files)) item.files = raw.files.slice(0,200).flatMap((file: Record<string,unknown>) => {
      if (!file || typeof file.path !== "string") return [];
      return [{ path: sanitizeExecutionTrace(file.path), action: ["created", "modified", "deleted"].includes(String(file.action)) ? file.action as "created" | "modified" | "deleted" : undefined, diff: typeof file.diff === "string" ? sanitizeExecutionTrace(file.diff) : undefined, linesAdded: typeof file.linesAdded === "number" && Number.isFinite(file.linesAdded) ? file.linesAdded : undefined, linesRemoved: typeof file.linesRemoved === "number" && Number.isFinite(file.linesRemoved) ? file.linesRemoved : undefined }];
    });
    if (raw.modelUsage && typeof raw.modelUsage.id==="string" && Number.isFinite(raw.modelUsage.turn)) {
      const usage={id:raw.modelUsage.id,turn:raw.modelUsage.turn,toolCallIds:Array.isArray(raw.modelUsage.toolCallIds)?raw.modelUsage.toolCallIds.filter((id:unknown)=>typeof id==="string"):[]} as NonNullable<DevelopmentProcessProgressItem["modelUsage"]>;
      for(const key of ["totalTokens","inputTokens","outputTokens","costUsd","durationMs"] as const)if(typeof raw.modelUsage[key]==="number" && Number.isFinite(raw.modelUsage[key]) && raw.modelUsage[key]>=0)usage[key]=raw.modelUsage[key];
      for(const key of ["model","provider"] as const)if(typeof raw.modelUsage[key]==="string")usage[key]=sanitizeExecutionTrace(raw.modelUsage[key]);
      item.modelUsage=usage;
    }
    if(typeof raw.dryRun==="boolean") item.dryRun=raw.dryRun;
    if (typeof raw.resultTruncated === "boolean") item.resultTruncated = raw.resultTruncated;
    const tests = raw.tests;
    if (tests && ["passed", "failed", "skipped", "total"].every(key => typeof tests[key] === "number" && Number.isFinite(tests[key]) && tests[key] >= 0)) item.tests = tests;
    valid.set(item.id, item);
  }
  return [...valid.values()];
}
/** Message order is the server's append order, never role grouping. Insert activity at its start time. */
export function activitySlots(messages: Message[], value: unknown, conversationId?: string | null) {
  const slots = new Map<number, DevelopmentProcessProgressItem[]>();
  for (const item of normalizeActivity(value)) {
    if (item.conversationId && item.conversationId !== conversationId) continue;
    const time = Date.parse(item.at);
    let index = messages.length;
    if (Number.isFinite(time)) {
      index = messages.findIndex(message => Number.isFinite(Date.parse(message.createdAt)) && Date.parse(message.createdAt) > time);
      if (index < 0) index = messages.length;
    } else if (messages.at(-1)?.role === "assistant") index--;
    const items = slots.get(index) ?? []; items.push(item); slots.set(index, items);
  }
  for (const items of slots.values()) items.sort((a,b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0) || (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id));
  return slots;
}
export function nearChatBottom(element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 96;
}

export type CodingActivityRun = { id: string; runId?: string; at: string; items: DevelopmentProcessProgressItem[]; status: string; language?: string; sequence?: number; usage?: NonNullable<DevelopmentProcessProgressItem["modelUsage"]>[] };
export function codingActivityRuns(value: unknown, process?: DevelopmentProcess): CodingActivityRun[] {
  const rows = normalizeActivity(value).filter(item => item.kind !== "assistant_message" && item.stage !== "template_ready");
  const groups = new Map<string, CodingActivityRun>();
  for (const item of rows) {
    const initial = !item.runId || item.runId === process?.initialRunId;
    const id = initial ? (process?.id ?? "process") + ":initial" : item.runId!;
    const group = groups.get(id) ?? { id, runId: initial ? process?.initialRunId : item.runId, at: item.at, items: [], status: "pending", language: item.language ?? process?.responseLanguage };
    group.items.push(item);
    if (item.language) group.language = item.language;
    if ((Date.parse(item.at) || 0) < (Date.parse(group.at) || 0)) group.at = item.at;
    groups.set(id,group);
  }
  for (const [runId,state] of Object.entries(process?.runStatuses ?? {})) {
    if (!runId || typeof state!=="string") continue;
    const id = runId === process?.initialRunId ? process.id + ":initial" : runId;
    if (!groups.has(id)) groups.set(id,{id,runId,at:process?.runStartedAts?.[runId] ?? process?.createdAt ?? "",items:[],status:state,language:process?.runLanguages?.[runId] ?? process?.responseLanguage});
  }
  for (const group of groups.values()) {
    const startedAt = group.runId ? process?.runStartedAts?.[group.runId] : undefined;
    if (startedAt && Number.isFinite(Date.parse(startedAt)) && (!Number.isFinite(Date.parse(group.at)) || Date.parse(startedAt)<Date.parse(group.at))) group.at=startedAt;
    group.items.sort((a,b)=>(Date.parse(a.at)||0)-(Date.parse(b.at)||0)||(a.sequence??0)-(b.sequence??0)||a.id.localeCompare(b.id));
    group.language = (group.runId ? process?.runLanguages?.[group.runId] : undefined) ?? group.language;
    const persisted = group.runId ? process?.runStatuses?.[group.runId] : undefined;
    const current = group.runId === process?.runId || !group.runId && !process?.initialRunId;
    const rawState = (current ? process?.status : undefined) ?? persisted;
    const state = typeof rawState === "string" && ["running","active","pending","queued","preparing","completed","failed","cancelled","waiting_for_user","waiting_for_approval","awaiting_approval","stopping","interrupted","suspended_by_flag"].includes(rawState) ? rawState : undefined;
    group.status = state === "waiting_for_user" || state === "awaiting_approval" ? "waiting_for_approval" : state === "queued" || state === "preparing" ? "pending" : state === "stopping" ? "running" : state === "interrupted" ? "failed" : state ?? (group.items.some(item=>["running","active"].includes(item.status??"")) ? "running" : group.items.some(item=>["awaiting_approval","waiting_for_approval"].includes(item.status??"")) ? "waiting_for_approval" : group.items.at(-1)?.status ?? "unknown");
    if (group.status === "active") group.status = "running";
  }
  return [...groups.values()];
}

/** Public commentary bounds a phase; commands keep their real Run and call IDs. */
export function codingActivityStages(value: unknown, process?: DevelopmentProcess, messages: Message[] = []): CodingActivityRun[] {
  const normalized = normalizeActivity(value);
  const compare = (a: {at:string;sequence?:number;id:string}, b: {at:string;sequence?:number;id:string}) => (Date.parse(a.at)||0)-(Date.parse(b.at)||0)||(a.sequence??0)-(b.sequence??0)||a.id.localeCompare(b.id);
  const activeStates = ["running","pending","waiting_for_approval"];
  const result: CodingActivityRun[] = [];
  for (const run of codingActivityRuns(normalized,process)) {
    const operations = run.items.filter(item=>!["agent","completed","model_usage"].includes(item.stage));
    const lastAt = Math.max(Date.parse(run.at)||0,...operations.map(item=>Date.parse(item.at)||0));
    const boundaries = normalized.filter(item=>item.kind==="assistant_message" && (item.runId===run.runId || !item.runId && !run.runId));
    for (const message of messages) {
      const time=Date.parse(message.createdAt);
      if(time>=(Date.parse(run.at)||0) && time<=lastAt) boundaries.push({id:message.id,stage:"message",title:"",at:message.createdAt});
    }
    boundaries.sort(compare);
    const phases = new Map<string,CodingActivityRun>();
    const phase = (boundary?: DevelopmentProcessProgressItem) => {
      const id=boundary ? run.id+":after:"+boundary.id : run.id;
      const existing=phases.get(id);
      if(existing)return existing;
      const next={...run,id,at:boundary?.at ?? run.at,sequence:boundary ? (boundary.sequence ?? 0)+0.5 : run.sequence,items:[] as DevelopmentProcessProgressItem[]};phases.set(id,next);return next;
    };
    for (const operation of operations) phase([...boundaries].reverse().find(boundary=>compare(boundary,operation)<=0)).items.push(operation);
    if(activeStates.includes(run.status)) phase(boundaries.at(-1));
    const ordered=[...phases.values()].sort(compare);
    for(let index=0;index<ordered.length;index++) {
      const stage=ordered[index]!;
      if(!stage.items.length && !activeStates.includes(run.status))continue;
      if(index===ordered.length-1 && activeStates.includes(run.status))stage.status=run.status;
      else stage.status=stage.items.some(item=>["running","active"].includes(item.status??"")) && activeStates.includes(run.status) ? "running" : stage.items.some(item=>["awaiting_approval","waiting_for_approval"].includes(item.status??"")) && activeStates.includes(run.status) ? "waiting_for_approval" : stage.items.some(item=>item.status==="failed") ? "failed" : run.status==="cancelled" && stage.items.some(item=>item.status==="cancelled") ? "cancelled" : "completed";
      stage.usage=[...new Map([...stage.items.map(item=>item.modelUsage),...run.items.filter(item=>item.stage==="model_usage" && item.modelUsage && (stage.items.some(action=>action.modelUsage?.id===item.modelUsage?.id) || index===ordered.length-1 && !item.modelUsage.toolCallIds.length)).map(item=>item.modelUsage)].filter((usage): usage is NonNullable<DevelopmentProcessProgressItem["modelUsage"]>=>Boolean(usage)).map(usage=>[usage.id,usage])).values()];
      result.push(stage);
    }
  }
  return result;
}

export function chatTimeline(messages: Message[], value: unknown, conversationId?: string | null, process?: DevelopmentProcess) {
  const normalized = normalizeActivity(value).filter(item => !item.conversationId || item.conversationId === conversationId);
  const groups = codingActivityStages(normalized,process,messages);
  const anchors = groups.map(group=>({id:group.id,stage:"run",title:"",at:group.at,sequence:group.sequence}));
  const slots = activitySlots(messages,[...normalized.filter(item=>item.kind==="assistant_message" && !messages.some(message=>message.role==="assistant" && message.content.trim()===item.title.trim())),...anchors],conversationId);
  const entries: ({ kind: "message"; message: Message; index: number } | { kind: "activity"; item: DevelopmentProcessProgressItem; run?: CodingActivityRun })[] = [];
  for (let index=0; index<=messages.length; index++) {
    for (const item of slots.get(index) ?? []) entries.push({kind:"activity",item,run:groups.find(group=>group.id===item.id)});
    if (index<messages.length) entries.push({kind:"message",message:messages[index]!,index});
  }
  return entries;
}

export function mergeConversationMessages(messages: Message[], extra: Message[] = []) {
  const merged = new Map(messages.map(message=>[message.id,message]));
  for (const message of extra) if (message && typeof message.id==="string" && typeof message.content==="string" && ["user","assistant"].includes(message.role)) merged.set(message.id,message);
  return [...merged.values()].sort((a,b)=>(Date.parse(a.createdAt)||0)-(Date.parse(b.createdAt)||0));
}
